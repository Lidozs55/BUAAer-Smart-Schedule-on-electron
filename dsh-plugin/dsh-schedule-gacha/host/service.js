/**
 * Business implementation of the gacha source adapter.
 *
 * One refresh cycle per game:
 *   1. official column list → newest version-update article
 *   2. parse its 255-char list summary; fetch the full column only when the
 *      summary lacks a date/version, or Endfield needs a deeper phase date
 *      (Bilibili rate limits full-column reads aggressively)
 *   3. official preview videos + recent official dynamics
 *   4. `planNext` pure rules → update / preview times
 *   5. reconcile the preview entry; updates remain source information only
 *
 * Failures never invent dates: the previous parsed article and plan stay in
 * place, and the error is only reported to the settings card / Agent.
 */
import {
  DEFAULT_PREVIEW_WINDOW,
  GAME_IDS,
  entryMarker,
  getGame,
  isGameId,
  kindMarker,
  ownsEntry,
  ownsKind,
} from './games.js'
import { articleUrl, createBilibili, dynamicText, stripHtml } from './bilibili.js'
import {
  atMinutes,
  cstParts,
  defaultUpdateEnd,
  isPreviewTitle,
  normalizeCstIso,
  parseArticle,
  planNext,
  previewByRule,
} from './parse.js'
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

const secondsToMs = value => {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0
}

/** Format an ISO instant as the CST wall clock, independent of host zone. */
function hhmm(iso) {
  const p = cstParts(iso)
  return p === null ? '' : `${pad(p.hour)}:${pad(p.minute)}`
}

function windowText(start, end) {
  const a = cstParts(start)
  const b = cstParts(end)
  if (a === null || b === null) return ''
  const sameDay = a.year === b.year && a.month === b.month && a.day === b.day
  return `${hhmm(start)}–${sameDay ? '' : '次日'}${hhmm(end)}（UTC+8）`
}

const confidenceLabel = confidence => (confidence === 'inferred' ? '（推算）' : '')

function titleFor(game, plan, kind) {
  const version = plan.version === null ? '' : `${plan.version} `
  return `${game.name} ${version}${kind === 'preview' ? '版本前瞻直播' : '版本更新'}`
}

function descriptionFor(game, state, plan, kind) {
  const evidence = kind === 'preview' ? plan.previewEvidence : plan.updateEvidence
  const confidence = kind === 'preview' ? plan.previewConfidence : plan.updateConfidence
  const lines = [
    `${entryMarker(game.id)}${kindMarker(kind)} 由「二游前瞻」插件同步；推算时间可编辑，官方明确时间锁定拖动。`,
    plan.version === null ? null : `版本：${plan.version}`,
    `依据：${evidence ?? '官方公告'}${confidenceLabel(confidence)}`,
  ]
  if (kind === 'update' && plan.updateStart !== null && plan.updateEnd !== null) {
    lines.push(`维护时段：${windowText(plan.updateStart, plan.updateEnd)}`)
  }
  const gs = state.games[game.id]
  if (typeof gs?.article?.url === 'string' && gs.article.url !== '') {
    lines.push(`官方来源：${gs.article.url}`)
  }
  return lines.filter(line => line !== null).join('\n')
}

/** Newest official article that claims to be a version update notice. */
function pickArticle(game, articles, nowMs) {
  if (!Array.isArray(articles)) return null
  return articles
    .filter(item => isObject(item) && typeof item.title === 'string')
    .filter(item => !game.excludeTitle.test(item.title))
    .filter(item => game.updateTitle.test(item.title))
    .filter(item => {
      const published = secondsToMs(item.publish_time)
      // A little tolerance for CST/UTC rounding at the day boundary.
      return published === 0 || published <= nowMs + DAY_MS
    })
    .sort((a, b) => Number(b.publish_time) - Number(a.publish_time))[0] ?? null
}

function validOverride(gs) {
  const override = gs.override
  if (!isObject(override)) return null
  if (typeof override.appliedAt !== 'string') return null
  const applied = new Date(override.appliedAt).getTime()
  if (!Number.isFinite(applied)) return null
  // A newer official article supersedes an Agent correction that was made
  // against the previous one; otherwise the correction stays authoritative.
  if (gs.article !== null && secondsToMs(gs.article.publishTime) > applied) return null
  return override
}

/** Layer an Agent correction over the rule-derived plan, field by field. */
function mergePlan(game, base, override) {
  if (override === null) return base
  const updateStart = override.updateStart ?? base?.updateStart ?? null
  const updateEnd = override.updateEnd
    ?? (override.updateStart !== null ? defaultUpdateEnd(updateStart, game) : null)
    ?? base?.updateEnd
    ?? (updateStart === null ? null : defaultUpdateEnd(updateStart, game))
  const previewStart = override.previewStart
    ?? base?.previewStart
    ?? (updateStart === null ? null : previewByRule(updateStart, game))
  const previewEnd = override.previewEnd
    ?? (override.previewStart !== null
      ? atMinutes(previewStart, DEFAULT_PREVIEW_WINDOW(game).endMinutes)
      : null)
    ?? base?.previewEnd
    ?? (previewStart === null
      ? null
      : atMinutes(previewStart, DEFAULT_PREVIEW_WINDOW(game).endMinutes))

  if (updateStart === null && previewStart === null) return base

  return {
    version: override.version ?? base?.version ?? null,
    updateStart,
    updateEnd,
    previewStart,
    previewEnd,
    updateConfidence: override.updateStart !== null
      ? 'agent'
      : base?.updateConfidence ?? null,
    previewConfidence: override.previewStart !== null
      ? 'agent'
      : base?.previewConfidence ?? null,
    updateEvidence: override.updateStart !== null
      ? override.note ?? 'Agent 核对官方公告'
      : base?.updateEvidence ?? null,
    previewEvidence: override.previewStart !== null
      ? override.note ?? 'Agent 核对官方公告'
      : base?.previewEvidence ?? null,
    generatedAt: new Date().toISOString(),
  }
}

const planIsLive = plan => plan !== null && (plan.updateStart !== null || plan.previewStart !== null)

/**
 * Summary-first merge. The 255-character list summary reliably carries the
 * maintenance start and the version end date, while a full column may open
 * with a *previous* phase's dates (Endfield). The full text therefore only
 * fills fields the summary did not produce.
 */
function mergeArticle(summary, full) {
  if (summary === null) return full
  return {
    version: summary.version ?? full.version,
    versionName: summary.versionName ?? full.versionName,
    updateStart: summary.updateStart ?? full.updateStart,
    updateEnd: summary.updateEnd ?? full.updateEnd,
    versionEnd: summary.versionEnd ?? full.versionEnd,
    previewAt: summary.previewAt ?? full.previewAt,
    phaseUpdate: summary.phaseUpdate ?? full.phaseUpdate,
  }
}

export function createGachaService(ctx, { service, bilibili } = {}) {
  if (service === undefined) throw new Error('gacha-schedule: scheduleCore is required')

  const bili = bilibili ?? createBilibili(ctx.logger)
  const state = normalizeState(service.getSourceState(SOURCE_ID))
  const lifetime = new AbortController()

  // One-line-per-stage logging: enough to reconstruct why a date was chosen
  // from the host log, without dumping announcement bodies.
  const info = (fmt, ...args) => ctx.logger.info(`gacha-schedule: ${fmt}`, ...args)
  const warn = (fmt, ...args) => ctx.logger.warn(`gacha-schedule: ${fmt}`, ...args)
  const short = iso => (typeof iso === 'string' ? iso.slice(5, 16).replace('T', ' ') : '—')
  // Log timestamps in the same zone the announcements use, not the host zone.
  const shortCst = ms => (Number.isFinite(ms) ? short(new Date(ms + 8 * HOUR_MS).toISOString()) : '—')

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
      title: titleFor(game, plan, 'preview'),
      description: descriptionFor(game, state, plan, 'preview'),
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
      // Compare against our last emitted values, not the last edited row.
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

  async function previewVideos(game, current, signal) {
    const rows = []
    // Series rows expose the uploader as `upMid`; search rows use `mid`.
    const authorId = item => String(item?.mid ?? item?.upMid ?? '')
    const officialOnly = items => (Array.isArray(items) ? items : [])
      .filter(item => authorId(item) === game.mid)
    const push = items => {
      for (const item of officialOnly(items)) rows.push(item)
    }
    const titleOf = item => stripHtml(String(item?.title ?? ''))

    push(await bili.featureVideos(game.mid, game.previewSeriesKeyword, { signal }))

    // The official series endpoint is the reliable path (WuWa only appears
    // there); search is a fallback for accounts whose series is not filled in.
    if (!rows.some(item => isPreviewTitle(titleOf(item)))) {
      const keywords = [
        `${game.name} 版本前瞻特别节目`,
        game.searchKeyword ?? `${game.name} 前瞻`,
      ]
      for (const keyword of keywords) {
        const found = await bili.searchVideos(keyword, { signal })
        push(found)
        if (officialOnly(found).some(item => isPreviewTitle(titleOf(item)))) break
      }
    }

    // Do not let the previous version's preview video masquerade as the next
    // one: only uploads after the current version went live are candidates.
    const floor = current?.updateStart === null || current?.updateStart === undefined
      ? Date.now() - 120 * DAY_MS
      : new Date(current.updateStart).getTime() - DAY_MS
    const seen = new Set()
    return rows
      .map(item => ({
        bvid: typeof item?.bvid === 'string' ? item.bvid : null,
        title: titleOf(item),
        pubdate: Number(item?.pubdate ?? 0),
      }))
      .filter(item => item.pubdate > 0 && item.pubdate * 1000 >= floor)
      .filter(item => isPreviewTitle(item.title))
      .filter(item => {
        const key = item.bvid ?? item.title
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
  }

  async function announcements(game, nowMs, signal) {
    const items = await bili.dynamics(game.mid, { signal })
    const cutoff = nowMs - 75 * DAY_MS
    return items
      .map(item => {
        const author = item?.modules?.module_author
        const seconds = Number(author?.pub_ts ?? 0)
        const id = String(item?.id_str ?? item?.id ?? '')
        return {
          text: dynamicText(item),
          pubdate: seconds,
          url: id === '' ? null : `https://t.bilibili.com/${id}`,
        }
      })
      .filter(item => item.text !== '' && item.pubdate > 0 && item.pubdate * 1000 >= cutoff)
  }

  async function refreshGame(id, { signal } = {}) {
    const game = getGame(id)
    if (game === undefined) throw invalid(`未知游戏：${id}`)
    if (!state.enabled[id]) return { game: id, skipped: true }
    if (disposed) return { game: id, skipped: true }

    const gs = state.games[id]
    const now = new Date()
    const nowMs = now.getTime()
    const startedMs = Date.now()
    const errors = []
    info('%s refresh start (article=%s)', game.name, gs.article?.id ?? 'none')

    let articles = []
    try {
      articles = await bili.articleList(game.mid, { signal })
      info('%s article list: %d rows, newest update notice %s', game.name, articles.length,
        pickArticle(game, articles, nowMs)?.title ?? 'none')
    } catch (error) {
      if (error?.name === 'AbortError') return { game: id, aborted: true }
      errors.push(`公告列表：${error.message}`)
      warn('%s article list failed: %s', game.name, error.message)
    }

    const picked = pickArticle(game, articles, nowMs)
    if (picked !== null) {
      const articleId = String(picked.id)
      info('%s picked article %s "%s" (published %s CST)', game.name, articleId, picked.title,
        shortCst(Number(picked.publish_time) * 1000))
      if (gs.article?.id !== articleId) {
        const published = Number(picked.publish_time)
        const summaryText = typeof picked.summary === 'string' ? stripHtml(picked.summary) : ''
        // The article list already carries the opening paragraph: all six
        // games state the maintenance start there, and HSR/ZZZ also state the
        // version end date, so a full-column read (heavily rate limited) is
        // usually unnecessary.
        let parsed = summaryText === ''
          ? null
          : parseArticle({
            title: picked.title,
            content: summaryText,
            publishTime: published,
            game,
          })
        let title = picked.title
        let publishTime = published

        const missing = []
        if (parsed === null) missing.push('摘要为空')
        else {
          if (parsed.updateStart === null) missing.push('缺更新时间')
          if (parsed.version === null) missing.push('缺版本号')
          // These two announce an explicit end date; a truncated summary must
          // not silently downgrade to the arithmetic cadence.
          if (game.expectVersionEnd === true && parsed.versionEnd === null) missing.push('缺版本结束日')
          // Endfield's next phase date lives deeper in the article.
          if (game.phaseHint === true && parsed.phaseUpdate === null) missing.push('缺阶段更新日')
        }
        // Only cv ids address `x/article/view`; an opus id would 404.
        const needsFullText = /^\d{1,12}$/.test(articleId) && missing.length > 0
        info('%s summary parse: version=%s update=%s→%s versionEnd=%s%s', game.name,
          parsed?.version ?? '—', short(parsed?.updateStart), short(parsed?.updateEnd),
          short(parsed?.versionEnd), needsFullText ? ` | full text needed (${missing.join('、')})` : ' | summary sufficient')

        if (needsFullText) {
          try {
            const view = await bili.articleView(articleId, { signal })
            if (disposed) return { game: id, aborted: true }
            const full = parseArticle({
              title: view.title || picked.title,
              content: view.content,
              publishTime: view.publishTime || published,
              game,
            })
            parsed = mergeArticle(parsed, full)
            title = view.title || picked.title
            publishTime = view.publishTime || published
            info('%s full column merged: version=%s update=%s→%s versionEnd=%s', game.name,
              parsed?.version ?? '—', short(parsed?.updateStart), short(parsed?.updateEnd),
              short(parsed?.versionEnd))
          } catch (error) {
            if (error?.name === 'AbortError') return { game: id, aborted: true }
            errors.push(`公告正文：${error.message}`)
            warn('%s full column failed: %s', game.name, error.message)
          }
        }

        if (parsed !== null && parsed.updateStart !== null) {
          gs.article = {
            id: articleId,
            title,
            publishTime,
            url: articleUrl(articleId),
          }
          gs.current = parsed
        } else if (parsed !== null && gs.current === null) {
          // Keep the card informative even when no date could be read yet.
          gs.article = {
            id: articleId,
            title,
            publishTime,
            url: articleUrl(articleId),
          }
          gs.current = parsed
        } else {
          errors.push('最新公告未解析出更新时间，沿用上次结果')
          warn('%s newest notice %s has no usable update time; keeping previous state',
            game.name, articleId)
        }

        if (parsed !== null && gs.current === parsed) {
          info('%s current version %s: update %s→%s, versionEnd %s', game.name,
            parsed.version ?? '—', short(parsed.updateStart), short(parsed.updateEnd),
            short(parsed.versionEnd))
        }
      }
    } else if (errors.length === 0) {
      errors.push('未找到版本更新公告')
      warn('%s no matching version-update notice in %d rows', game.name, articles.length)
    }

    let videos = []
    let feed = []
    if (gs.current !== null) {
      try {
        videos = await previewVideos(game, gs.current, signal)
      } catch (error) {
        if (error?.name === 'AbortError') return { game: id, aborted: true }
        errors.push(`前瞻视频：${error.message}`)
      }
      try {
        feed = await announcements(game, nowMs, signal)
      } catch (error) {
        if (error?.name === 'AbortError') return { game: id, aborted: true }
        errors.push(`官方动态：${error.message}`)
      }
      info('%s preview videos=%d, recent dynamics=%d', game.name, videos.length, feed.length)
    }

    if (disposed) return { game: id, aborted: true }

    return withGame(id, async () => {
      if (disposed) return { game: id, aborted: true }
      if (!state.enabled[id]) {
        await removeEntries(id)
        await persist()
        return { game: id, skipped: true }
      }

      const gsCurrent = state.games[id]
      const override = validOverride(gsCurrent)
      if (override === null) gsCurrent.override = null

      let officialPlan = gsCurrent.current === null
        ? null
        : planNext({
          game,
          current: gsCurrent.current,
          now: now.toISOString(),
          videos,
          announcements: feed,
        })
      const prior = gsCurrent.officialPlan
      // A missing teaser/replay (including an outage) is not a retraction.
      // Retain explicit same-version timing until new explicit evidence or a
      // new version replaces it; never downgrade confirmed dates to arithmetic.
      if (prior?.previewConfidence === 'official' && prior.previewStart && prior.previewEnd
        && new Date(prior.previewStart).getTime() >= nowMs - 2 * DAY_MS
        && (officialPlan === null || officialPlan.version === prior.version)
        && officialPlan?.previewConfidence !== 'official') {
        officialPlan = {
          ...(officialPlan ?? prior),
          previewStart: prior.previewStart, previewEnd: prior.previewEnd,
          previewConfidence: prior.previewConfidence, previewEvidence: prior.previewEvidence,
        }
      }
      const plan = mergePlan(game, officialPlan, gsCurrent.override)

      gsCurrent.officialPlan = officialPlan
      gsCurrent.plan = plan
      gsCurrent.lastRefreshAt = now.toISOString()
      gsCurrent.lastError = errors.length === 0 ? null : errors.join('；')
      gsCurrent.status = plan === null
        ? 'error'
        : errors.length === 0 ? 'ok' : 'partial'
      if (plan === null && gsCurrent.lastError === null) {
        gsCurrent.lastError = '暂无可用的版本信息'
      }

      if (plan === null) {
        warn('%s no plan: %s', game.name, gsCurrent.lastError)
      } else {
        info('%s plan %s: update %s→%s (%s), preview %s (%s)', game.name,
          plan.version ?? '—', short(plan.updateStart), short(plan.updateEnd),
          plan.updateEvidence ?? plan.updateConfidence ?? '—',
          short(plan.previewStart), plan.previewEvidence ?? plan.previewConfidence ?? '—')
      }

      await reconcileEntries(game, plan, Date.now())
      state.lastRefreshAt = now.toISOString()
      await persist()
      info('%s refresh %s in %d ms%s', game.name, gsCurrent.status, Date.now() - startedMs,
        gsCurrent.lastError === null ? '' : ` (${gsCurrent.lastError})`)
      return {
        game: id,
        status: gsCurrent.status,
        plan,
        error: gsCurrent.lastError,
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
      version: gs.plan?.version ?? gs.current?.version ?? null,
      article: gs.article,
      plan: gs.plan,
      officialPlan: gs.officialPlan,
      override: gs.override,
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
   * Agent-only write path. The caller names a game and explicit instants; it
   * can never address an arbitrary schedule entry, so other schedules are
   * untouchable by construction.
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
      const normalized = normalizeCstIso(value)
      if (normalized === null) {
        throw invalid(`${key} 必须是带时区的 ISO 8601：${value}`)
      }
      return normalized
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
      && new Date(updateEnd).getTime() <= new Date(updateStart).getTime()) {
      throw invalid('update_end 必须晚于 update_start')
    }
    if (previewStart !== null && previewEnd !== null
      && new Date(previewEnd).getTime() <= new Date(previewStart).getTime()) {
      throw invalid('preview_end 必须晚于 preview_start')
    }
    if (previewStart !== null && updateStart !== null
      && new Date(previewStart).getTime() >= new Date(updateStart).getTime()) {
      throw invalid('前瞻直播必须早于版本更新')
    }
    if (updateStart === null && previewStart === null) {
      throw invalid('至少给出 update_start 或 preview_start（清除覆盖请用 clear）')
    }

    const game = getGame(id)
    info('%s agent override: version=%s update=%s→%s preview=%s→%s note=%s', game.name,
      version ?? '—', short(updateStart), short(updateEnd), short(previewStart),
      short(previewEnd), note ?? '—')
    await withGame(id, async () => {
      const gs = state.games[id]
      const override = {
        version,
        updateStart,
        updateEnd,
        previewStart,
        previewEnd,
        note,
        appliedAt: new Date().toISOString(),
      }
      const next = mergePlan(game, gs.officialPlan, override)
      if (!planIsLive(next)) throw invalid('给出的时间不足以形成一条日程')
      gs.override = override
      gs.plan = next
      gs.status = gs.lastError === null ? 'ok' : 'partial'
      await reconcileEntries(game, next, Date.now())
      await persist()
    })

    return publicGame(id)
  }

  async function clearOverride(id) {
    if (!isGameId(id)) throw invalid(`未知游戏：${id}`)
    info('%s agent override cleared', getGame(id).name)
    await withGame(id, async () => {
      const gs = state.games[id]
      gs.override = null
      gs.plan = gs.officialPlan
      gs.status = gs.plan === null ? 'error' : gs.lastError === null ? 'ok' : 'partial'
      await reconcileEntries(getGame(id), gs.plan, Date.now())
      await persist()
    })
    return publicGame(id)
  }

  const WATCH_PROMPT = [
    '这是「二游前瞻」周检。请核对原神、崩坏：星穹铁道、绝区零、鸣潮、明日方舟：终末地、异环的官方版本前瞻直播与版本更新时间。',
    '先调用 gacha_schedule（action=list）查看插件现有状态摘要；摘要不含完整推算依据，也不作为官方证据。',
    '再到各游戏 B 站官方账号查看最近的版本更新公告、前瞻预告和动态，重点确认官方是否已给出明确日期/时间；终末地的版本节奏不固定，必须优先核对。',
    '发现官方明确时间时，用 gacha_schedule（action=apply_official）按游戏写入 update_start / preview_start（带时区 ISO 8601，UTC+8）；只改本插件维护的日程，不要动其他条目。',
    '仅在成功核对且没有新信息时回复「本周无变化」；检索工具缺失、官方来源无法访问或材料不足时说明未核实，不推断无变化。',
  ].join('\n')

  /**
   * Register (or remove) the durable weekly check. `ctx.schedule` is an
   * optional bundle; without it the six-hour HTTP refresh still works and the
   * tool reports the degraded mode instead of failing.
   */
  async function setWatch(sessionId, { enabled = true } = {}) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw invalid('无法确定当前会话，周检未登记')
    }
    const schedule = typeof ctx.get === 'function' ? ctx.get('schedule') : undefined
    const watch = state.watch

    if (!enabled) {
      if (schedule !== undefined && schedule !== null && watch.scheduleId !== null) {
        try {
          await schedule.delete({ sessionId: watch.sessionId ?? sessionId, id: watch.scheduleId })
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
