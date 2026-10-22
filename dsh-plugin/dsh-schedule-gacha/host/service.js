/**
 * Business implementation of the gacha source adapter.
 *
 * Since the gacha-calendar service went live, this adapter no longer talks to
 * Bilibili and no longer parses announcements: collection, parsing and
 * next-version planning happen server-side (gacha.modenc.top). One refresh
 * per game now means:
 *
 *   1. GET /api/games — formatted plan (update/preview, confidences, evidence)
 *   2. GET /api/posts?is_update_notice=1 — the announcement behind the plan
 *   3. reconcile the preview entry; updates remain source information only
 *
 * Official-time corrections are forwarded to the service (admin token), so
 * the web UI and every plugin host see the same correction immediately.
 * Failures never invent dates: the previous plan stays in place and the
 * error is reported to the settings card / Agent.
 */
import {
  GAME_IDS,
  entryMarker,
  getGame,
  isGameId,
  kindMarker,
  ownsEntry,
  ownsKind,
} from './games.js'
import { createCalendarApi } from './calendarApi.js'
import { SOURCE_ID, normalizeState } from './state.js'

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const REFRESH_TTL_MS = 3 * HOUR_MS
const AUTO_REFRESH_MS = 6 * HOUR_MS

const pad = value => String(value).padStart(2, '0')

export class GachaError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'GachaError'
    this.code = code
  }
}

const invalid = message => new GachaError('invalid_input', message)

const isObject = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Re-express a UTC (or any offset) RFC3339 instant as an explicit +08:00 ISO string. */
export function toCstIso(value) {
  if (typeof value !== 'string' || value === '') return null
  // Reject naive datetimes on purpose — the legacy "local time stored as UTC"
  // bug must not come back through service data.
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return null
  const shifted = new Date(ms + 8 * HOUR_MS)
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
    + `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}+08:00`
}

/** Re-express any offset-ful ISO instant as UTC RFC3339 for the service API. */
export const toUtcIso = value => {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** Map a service prediction view onto the plugin's plan shape. */
export function planFromApi(view) {
  const prediction = view?.prediction
  if (!isObject(prediction)) return null
  const window = meta => (isObject(meta) && typeof meta.utc === 'string' && meta.utc !== '')
    ? { start: toCstIso(meta.utc), end: toCstIso(meta.end_utc) }
    : null
  const update = window(prediction.update)
  const preview = window(prediction.preview)
  if (update === null && preview === null) return null
  return {
    version: typeof prediction.version === 'string' && prediction.version !== ''
      ? prediction.version : null,
    updateStart: update?.start ?? null,
    updateEnd: update?.end ?? null,
    previewStart: preview?.start ?? null,
    previewEnd: preview?.end ?? null,
    updateConfidence: prediction.update_confidence || null,
    previewConfidence: prediction.preview_confidence || null,
    updateEvidence: prediction.update_evidence || null,
    previewEvidence: prediction.preview_evidence || null,
    generatedAt: new Date().toISOString(),
  }
}

/** Announcement metadata from the newest update-notice post. */
function articleFromPost(post) {
  if (!isObject(post)) return null
  return {
    id: String(post.external_id ?? ''),
    title: typeof post.title === 'string' ? post.title : '',
    publishTime: Math.floor(Date.parse(post.publish_time?.utc ?? '') / 1000) || 0,
    url: typeof post.url === 'string' ? post.url : '',
  }
}

const confidenceLabel = confidence => (confidence === 'inferred' ? '（推算）' : '')

function titleFor(game, plan) {
  const version = plan?.version == null ? '' : `${plan.version} `
  return `${game.name} ${version}版本前瞻直播`
}

function descriptionFor(game, state, plan) {
  const lines = [
    `${entryMarker(game.id)}${kindMarker('preview')} 由「二游前瞻」插件经 gacha-calendar 服务同步；推算时间可编辑，官方明确时间锁定拖动。`,
    plan?.version == null ? null : `版本：${plan.version}`,
    `依据：${plan?.previewEvidence ?? '官方公告'}${confidenceLabel(plan?.previewConfidence)}`,
  ]
  const gs = state.games[game.id]
  if (typeof gs?.article?.url === 'string' && gs.article.url !== '') {
    lines.push(`官方来源：${gs.article.url}`)
  }
  return lines.filter(line => line !== null).join('\n')
}

const planIsLive = plan => plan !== null && (plan.updateStart !== null || plan.previewStart !== null)

export function createGachaService(ctx, { service, calendarApi } = {}) {
  if (service === undefined) throw new Error('gacha-schedule: scheduleCore is required')

  const api = calendarApi ?? createCalendarApi()
  const state = normalizeState(service.getSourceState(SOURCE_ID))
  const lifetime = new AbortController()

  const info = (fmt, ...args) => ctx.logger.info(`gacha-schedule: ${fmt}`, ...args)
  const warn = (fmt, ...args) => ctx.logger.warn(`gacha-schedule: ${fmt}`, ...args)
  const short = iso => (typeof iso === 'string' ? iso.slice(5, 16).replace('T', ' ') : '—')

  /** Per-game mutex: entry reconciliation and enable/disable never interleave. */
  const gameChains = new Map()
  const withGame = (id, task) => {
    const previous = gameChains.get(id) ?? Promise.resolve()
    const run = previous.then(task, task)
    gameChains.set(id, run.then(() => undefined, () => undefined))
    return run
  }

  /** Refresh worker: one queue, so timers and buttons never double-fetch. */
  const queue = new Set()
  let worker = null

  let disposed = false
  let dirty = false
  let persisted = JSON.stringify(service.getSourceState(SOURCE_ID))
  let persistChain = Promise.resolve()

  function persist() {
    if (disposed) return persistChain
    dirty = true
    persistChain = persistChain.then(async () => {
      if (!dirty || disposed) return
      dirty = false
      const next = JSON.stringify(state)
      if (next === persisted) return
      await service.setSourceState(SOURCE_ID, state)
      persisted = next
    }, () => undefined)
    return persistChain
  }

  async function reconcileEntries(game, plan, nowMs) {
    const gs = state.games[game.id]
    const owned = service.listEntries().filter(entry => ownsEntry(entry, game.id))
    // UPDATE is source metadata, never a calendar block, including old imports.
    const updates = owned.filter(entry => ownsKind(entry, game.id, 'update')).map(entry => entry.id)
    if (updates.length > 0) await service.deleteEntry(updates)
    gs.entries.update = null
    if (!planIsLive(plan)) return

    const previews = owned.filter(entry => ownsKind(entry, game.id, 'preview'))
    if (plan.previewStart === null || plan.previewEnd === null
      || new Date(plan.previewStart).getTime() < nowMs - 2 * DAY_MS) {
      if (previews.length > 0) await service.deleteEntry(previews.map(entry => entry.id))
      gs.entries.preview = null
      gs.syncedPreview = null
      return
    }
    const desired = {
      title: titleFor(game, plan),
      description: descriptionFor(game, state, plan),
      location: null, category: 'other', allDay: false,
      start: plan.previewStart, end: plan.previewEnd,
      lock: plan.previewConfidence === 'official' || plan.previewConfidence === 'agent',
      source: SOURCE_ID, sourceKey: game.id + ':preview',
    }
    let target = previews.find(entry => entry.id === gs.entries.preview) ?? previews[0] ?? null
    if (target === null) {
      target = await service.createEntry(desired, { allowConflicts: true })
    } else {
      const patch = { ...desired }
      // A refresh owns its source facts, not the user's editable fields.
      const previous = gs.syncedPreview
      for (const key of ['title', 'description', 'location', 'category', 'allDay', 'start', 'end']) {
        const time = key === 'start' || key === 'end' || key === 'allDay'
        if (time && desired.lock) continue
        if (previous !== null && previous !== undefined && target[key] !== previous[key]) {
          patch[key] = target[key]
        } else if (!previous && !target.lock) {
          patch[key] = target[key]
        }
      }
      if (Object.keys(patch).some(key => key === 'allDay'
        ? Boolean(target[key]) !== Boolean(patch[key]) : target[key] !== patch[key])) {
        target = await service.updateEntry(target.id, patch, { allowConflicts: true })
      }
    }
    gs.entries.preview = target.id
    gs.syncedPreview = desired
    const duplicates = previews.filter(entry => entry.id !== target.id).map(entry => entry.id)
    if (duplicates.length > 0) await service.deleteEntry(duplicates)
  }

  async function removeEntries(gameId) {
    const ids = service.listEntries()
      .filter(entry => ownsEntry(entry, gameId))
      .map(entry => entry.id)
    if (ids.length > 0) await service.deleteEntry(ids)
    state.games[gameId].entries = { preview: null, update: null }
    state.games[gameId].syncedPreview = null
  }

  /** Apply cached source facts immediately, without waiting for a feed refresh. */
  async function reconcileCachedEntries() {
    for (const id of GAME_IDS) {
      if (disposed) return
      await withGame(id, async () => {
        if (disposed) return
        if (state.enabled[id]) {
          await reconcileEntries(getGame(id), state.games[id].plan, Date.now())
        } else {
          await removeEntries(id)
        }
      })
    }
    await persist()
  }

  /** Fetch the formatted state of every enabled game from the service. */
  async function fetchViews(ids, signal) {
    const views = await api.games(signal)
    if (!Array.isArray(views)) throw new GachaError('bad_response', '服务返回的游戏列表不可用')
    const wanted = new Set(ids)
    return views.filter(view => wanted.has(view.id))
  }

  async function refreshGame(id, { signal } = {}) {
    const game = getGame(id)
    if (game === undefined) throw invalid(`未知游戏：${id}`)
    if (!state.enabled[id]) return { game: id, skipped: true }
    if (disposed) return { game: id, skipped: true }

    const gs = state.games[id]
    const startedMs = Date.now()
    const errors = []
    info('%s refresh start (from gacha-calendar)', game.name)

    let view = null
    let notice = null
    try {
      const [views, latest] = await Promise.all([
        fetchViews([id], signal),
        api.latestNotice(id, signal).catch(error => {
          errors.push(`公告元数据：${error.message}`)
          return null
        }),
      ])
      view = views.find(item => item.id === id) ?? null
      notice = latest
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) return { game: id, aborted: true }
      errors.push(`服务接口：${error.message}`)
      warn('%s service fetch failed: %s', game.name, error.message)
    }

    return withGame(id, async () => {
      if (disposed) return { game: id, aborted: true }
      if (!state.enabled[id]) {
        await removeEntries(id)
        await persist()
        return { game: id, skipped: true }
      }

      const plan = view === null ? gs.plan : planFromApi(view)
      if (view !== null) {
        if (notice !== null) gs.article = articleFromPost(notice)
        gs.lastError = null
      }

      gs.plan = plan
      gs.lastRefreshAt = new Date().toISOString()
      if (view !== null && view.status !== undefined) {
        gs.status = view.status === 'ok' ? 'ok' : view.status === 'partial' ? 'partial' : 'error'
        if (typeof view.last_error === 'string' && view.last_error !== '') {
          errors.push(`服务采集：${view.last_error}`)
        }
      }
      if (plan === null) gs.status = 'error'
      gs.lastError = errors.length === 0 ? null : errors.join('；')
      if (plan === null && gs.lastError === null) {
        gs.lastError = '暂无可用的版本信息'
      }

      if (plan === null) {
        warn('%s no plan: %s', game.name, gs.lastError)
      } else {
        info('%s plan %s: update %s（%s）, preview %s（%s）', game.name,
          plan.version ?? '—', short(plan.updateStart), plan.updateEvidence ?? '—',
          short(plan.previewStart), plan.previewEvidence ?? '—')
      }

      await reconcileEntries(game, plan, Date.now())
      state.lastRefreshAt = new Date().toISOString()
      await persist()
      info('%s refresh %s in %d ms', game.name, gs.status, Date.now() - startedMs)
      return {
        game: id,
        status: gs.status,
        plan,
        error: gs.lastError,
      }
    })
  }

  function requestRefresh(ids = GAME_IDS) {
    const queued = []
    for (const id of ids) {
      if (isGameId(id) && state.enabled[id]) {
        queue.add(id)
        queued.push(id)
      }
    }
    if (queued.length > 0) info('refresh queued: %s', queued.join(','))
    if (worker === null && queue.size > 0 && !disposed) {
      const signal = lifetime.signal
      worker = (async () => {
        const results = []
        try {
          while (queue.size > 0 && !disposed) {
            const id = queue.values().next().value
            queue.delete(id)
            try {
              results.push(await refreshGame(id, { signal }))
            } catch (error) {
              if (error?.name === 'AbortError') break
              ctx.logger.warn('gacha-schedule: refresh %s failed: %s', id, error.message)
              results.push({ game: id, status: 'error', error: error.message })
            }
          }
        } finally {
          worker = null
        }
        info('refresh queue drained: %d result(s)', results.length)
        return results
      })()
    }
    return worker ?? Promise.resolve([])
  }

  function needsRefresh() {
    const cutoff = Date.now() - REFRESH_TTL_MS
    return GAME_IDS.some(id => {
      if (!state.enabled[id]) return false
      const gs = state.games[id]
      if (gs.plan === null) return true
      const stamp = Date.parse(gs.lastRefreshAt ?? '')
      return !Number.isFinite(stamp) || stamp < cutoff
    })
  }

  function publicGame(id) {
    const game = getGame(id)
    const gs = state.games[id]
    return {
      id,
      name: game.name,
      enabled: state.enabled[id],
      status: gs.status,
      lastRefreshAt: gs.lastRefreshAt,
      lastError: gs.lastError,
      version: gs.plan?.version ?? null,
      article: gs.article,
      plan: gs.plan,
      officialPlan: gs.plan,
      override: null,
      entries: { ...gs.entries },
    }
  }

  function getPublicState() {
    return {
      source: SOURCE_ID,
      refreshing: worker !== null,
      lastRefreshAt: state.lastRefreshAt,
      enabled: { ...state.enabled },
      watch: {
        ...state.watch,
        enabled: state.watch.scheduleId !== null,
        weekday: 3,
        time: '10:00',
        timeZone: 'Asia/Shanghai',
      },
      games: GAME_IDS.map(publicGame),
    }
  }

  async function setEnabled(id, enabled) {
    if (!isGameId(id)) throw invalid(`未知游戏：${id}`)
    if (typeof enabled !== 'boolean') throw invalid('enabled 必须是布尔值')
    state.enabled[id] = enabled
    info('%s %s', getGame(id).name, enabled ? 'enabled' : 'disabled')

    await withGame(id, async () => {
      const gs = state.games[id]
      if (!enabled) {
        await removeEntries(id)
        gs.status = 'disabled'
        gs.lastError = null
      } else if (planIsLive(gs.plan)) {
        gs.status = gs.lastError === null ? 'ok' : 'partial'
        await reconcileEntries(getGame(id), gs.plan, Date.now())
      } else {
        gs.status = 'idle'
      }
      await persist()
    })

    if (enabled) void requestRefresh([id])
    return publicGame(id)
  }

  /**
   * Official-time correction. The plugin validates locally, then forwards the
   * correction to the gacha-calendar service (which layers it over the rule
   * plan for every consumer) and re-reads the merged plan.
   */
  async function applyOfficial(input) {
    const id = input?.game
    if (!isGameId(id)) throw invalid(`game 须为 ${GAME_IDS.join('|')}：${id}`)
    const read = key => {
      const value = input[key]
      if (value === undefined || value === null || value === '') return null
      if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
        throw invalid(key + ' 必须是带时区的 ISO 8601')
      }
      const normalized = toCstIso(value)
      if (normalized === null) {
        throw invalid(`${key} 必须是带时区的 ISO 8601：${value}`)
      }
      return { cst: normalized, utc: toUtcIso(value) }
    }
    const version = input.version === undefined || input.version === null || input.version === ''
      ? null
      : String(input.version).trim()
    const note = typeof input.note === 'string' && input.note.trim() !== ''
      ? input.note.trim()
      : null
    const updateStart = read('update_start')
    const updateEnd = read('update_end')
    const previewStart = read('preview_start')
    const previewEnd = read('preview_end')

    if (updateStart !== null && updateEnd !== null
      && Date.parse(updateEnd.cst) <= Date.parse(updateStart.cst)) {
      throw invalid('update_end 必须晚于 update_start')
    }
    if (previewStart !== null && previewEnd !== null
      && Date.parse(previewEnd.cst) <= Date.parse(previewStart.cst)) {
      throw invalid('preview_end 必须晚于 preview_start')
    }
    if (previewStart !== null && updateStart !== null
      && Date.parse(previewStart.cst) >= Date.parse(updateStart.cst)) {
      throw invalid('前瞻直播必须早于版本更新')
    }
    if (updateStart === null && previewStart === null) {
      throw invalid('至少给出 update_start 或 preview_start（清除覆盖请用 clear）')
    }

    const game = getGame(id)
    info('%s forwarding official correction to gacha-calendar', game.name)
    try {
      await api.putOverride(id, {
        version: version ?? undefined,
        update_start: updateStart?.utc,
        update_end: updateEnd?.utc,
        preview_start: previewStart?.utc,
        preview_end: previewEnd?.utc,
        note: note ?? undefined,
      })
    } catch (error) {
      warn('%s override forward failed: %s', game.name, error.message)
      throw new GachaError('service_error', `写入 gacha-calendar 失败：${error.message}`)
    }
    await refreshGame(id, { signal: lifetime.signal })
    const result = publicGame(id)
    if (result.plan === null) throw invalid('给出的时间不足以形成一条日程')
    return result
  }

  async function clearOverride(id) {
    if (!isGameId(id)) throw invalid(`未知游戏：${id}`)
    info('%s clearing service override', getGame(id).name)
    try {
      await api.deleteOverride(id)
    } catch (error) {
      warn('%s override clear failed: %s', id, error.message)
      throw new GachaError('service_error', `清除 gacha-calendar 覆盖失败：${error.message}`)
    }
    await refreshGame(id, { signal: lifetime.signal })
    return publicGame(id)
  }

  const WATCH_PROMPT = [
    '这是「二游前瞻」周检。请核对原神、崩坏：星穹铁道、绝区零、鸣潮、明日方舟：终末地、异环的官方版本前瞻直播与版本更新时间。',
    '先运行 `schedule gacha list` 查看插件现有状态摘要（需要时先 `schedule gacha --help`）；摘要不含完整推算依据，也不作为官方证据。',
    '再到各游戏 B 站官方账号查看最近的版本更新公告、前瞻预告和动态，重点确认官方是否已给出明确日期/时间；终末地的版本节奏不固定，必须优先核对。',
    '发现官方明确时间时，用 `schedule gacha apply-official --game <id> --update-start/--preview-start ...` 按游戏写入（带时区 ISO 8601，UTC+8）；只改本插件维护的日程，不要动其他条目。',
    '需要阅读公告原文时可先用 `schedule gacha posts --game <id>` 查看服务保存的原始公告与动态，再与官方渠道相互印证。',
    '仅在成功核对且没有新信息时回复「本周无变化」；检索工具缺失、官方来源无法访问或材料不足时说明未核实，不推断无变化。',
  ].join('\n')

  /**
   * Register (or remove) the durable weekly check via the platform
   * automation-task bundle. The six-hour HTTP refresh stays available, and the
   * command reports degraded mode when the bundle is absent.
   */
  async function setWatch(sessionId, { enabled = true } = {}) {
    const schedule = typeof ctx.get === 'function' ? ctx.get('schedule') : undefined
    const watch = state.watch

    if (!enabled) {
      if (schedule !== undefined && schedule !== null
        && watch.scheduleId !== null && watch.sessionId !== null) {
        try {
          await schedule.delete({ sessionId: watch.sessionId, id: watch.scheduleId })
        } catch (error) {
          ctx.logger.warn('gacha-schedule: watch delete failed: %s', error.message)
        }
      }
      state.watch = { sessionId: null, scheduleId: null, registeredAt: null }
      await persist()
      info('weekly watch disabled')
      return { enabled: false, reason: '已取消每周 Agent 核对。' }
    }

    if (schedule === undefined || schedule === null) {
      return {
        enabled: false,
        reason: '当前部署未启用「自动化任务」，无法登记每周 Agent 核对；每 6 小时的后台刷新仍然有效。',
      }
    }

    if (typeof sessionId !== 'string' || sessionId === '') {
      throw invalid('缺少会话 id：请用 --session <id> 或设置 DSH_SESSION_ID / SCHEDULE_SESSION_ID')
    }

    if (watch.scheduleId !== null && watch.sessionId !== null) {
      try {
        await schedule.delete({ sessionId: watch.sessionId, id: watch.scheduleId })
      } catch (error) {
        ctx.logger.warn('gacha-schedule: stale watch delete failed: %s', error.message)
      }
      // The old task is gone even if the delete call failed (e.g. already
      // removed in the automation UI); never point the card at a dead id.
      state.watch = { sessionId: null, scheduleId: null, registeredAt: null }
      await persist()
    }

    try {
      const record = await schedule.create(sessionId, {
        title: '[gacha] 二游前瞻周检',
        prompt: WATCH_PROMPT,
        weekly: {
          time: '10:00:00',
          time_zone: 'Asia/Shanghai',
          weekdays: [3],
        },
      })
      state.watch = {
        sessionId,
        scheduleId: record.id,
        registeredAt: new Date().toISOString(),
      }
      await persist()
      info('weekly watch enabled: %s (Wed 10:00 Asia/Shanghai)', record.id)
      return {
        enabled: true,
        scheduleId: record.id,
        weekday: 3,
        time: '10:00',
        timeZone: 'Asia/Shanghai',
        prompt: WATCH_PROMPT,
      }
    } catch (error) {
      ctx.logger.warn('gacha-schedule: watch register failed: %s', error.message)
      return { enabled: false, reason: `周检登记失败：${error.message}` }
    }
  }

  function dispose() {
    disposed = true
    lifetime.abort()
    queue.clear()
  }

  return {
    sourceId: SOURCE_ID,
    autoRefreshMs: AUTO_REFRESH_MS,
    calendarApi: api,
    getPublicState,
    getPublicGame: publicGame,
    requestRefresh,
    refreshGame: id => requestRefresh([id]),
    needsRefresh,
    reconcileCachedEntries,
    setEnabled,
    applyOfficial,
    clearOverride,
    setWatch,
    persist,
    dispose,
  }
}
