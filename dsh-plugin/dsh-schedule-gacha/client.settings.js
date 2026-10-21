/**
 * Settings card of the gacha source adapter.
 *
 * Registered into the core's `schedule.settings.blocks` slot. Each game has
 * its own switch so a user who only follows one or two titles never sees the
 * rest in the calendar. Turning a game off deletes only the preview entries this
 * plugin wrote for it.
 */
window.__ModuleLoader__.load({
  id: '@lidozs55/dsh-schedule-gacha/client.settings.js',
  factory: require => {
    const React = require('react')
    const { useState, useEffect, useRef } = React
    const h = React.createElement

    const API_PATH = '/api/gacha-schedule'

    class ApiError extends Error {
      constructor(payload) {
        super(payload.message)
        this.code = payload.code
        this.details = payload.details
      }
    }

    async function parseResult(response) {
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (body && body.ok) return body.value
      throw new ApiError(body?.error ?? {
        code: `http_${response.status}`,
        message: `HTTP ${response.status}`,
      })
    }

    const post = (op, payload) => globalThis.fetch(API_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, ...payload }),
    }).then(parseResult)

    const api = {
      state: () => globalThis.fetch(API_PATH).then(parseResult),
      setEnabled: (game, enabled) => post('setEnabled', { game, enabled }),
      refresh: game => post('refresh', game === undefined ? {} : { game }),
    }

    /** `2026-11-04T06:00:00+08:00` → `11-04 06:00` (already CST). */
    const short = iso => (typeof iso === 'string' ? iso.slice(5, 16).replace('T', ' ') : '')

    const notifyDataChanged = () => {
      window.dispatchEvent(new CustomEvent('schedule:data-changed'))
    }

    const zh = {
      'settings.title': '二游前瞻',
      'settings.hint': '自动跟踪六款游戏的版本信息；仅前瞻直播写入日程，版本更新只作来源信息。推算时间可编辑，官方明确时间锁定拖动。',
      'settings.disabled': '已关闭，不写入日程',
      'settings.waiting': '等待首次刷新…',
      'settings.unknown': '待定',
      'settings.update': '更新 {time}',
      'settings.preview': '前瞻 {time}',
      'settings.refresh': '立即刷新',
      'settings.refreshing': '刷新中…',
      'settings.started': '已开始刷新，稍候…',
      'settings.agent': '让 Agent 核对',
      'settings.last': '上次刷新：{time}',
      'settings.never': '尚未刷新',
      'settings.auto': '后台每 6 小时自动刷新；关闭开关会移除该游戏由本插件写入的日程。',
      'settings.watchOn': '周检已开启（每周三 10:00 由 Agent 核对）',
      'settings.watchOff': '周检未开启（需「自动化任务」bundle）',
      'settings.error': '刷新失败：{message}',
      'settings.notice': '公告',
      'settings.agentPrompt': [
        '请核对这六款二游的官方版本前瞻直播与版本更新时间：原神、崩坏：星穹铁道、绝区零、鸣潮、明日方舟：终末地、异环。',
        '先用 gacha_schedule（action=list）查看插件当前状态摘要；摘要不是官方证据，再用可用检索工具到各游戏 B 站官方账号核对最近的版本更新公告、前瞻预告和动态。',
        '发现官方明确时间时，用 gacha_schedule（action=apply_official）按游戏写入带时区的 ISO 8601 时间；只修改插件维护的二游条目，不要动其他日程。',
        '终末地的版本节奏不固定，请重点核对。无法检索或材料不足时明确说明未核实，不推断无变化。核对完成后，用 gacha_schedule（action=watch）开启固定每周三 10:00（Asia/Shanghai）的周检。',
      ].join('\n'),
    }

    const en = {
      'settings.title': 'Gacha previews',
      'settings.hint': 'Tracks six games; only preview streams enter the calendar. Updates stay source information. Inferred times are editable; explicit official times lock dragging.',
      'settings.disabled': 'Off — no entries',
      'settings.waiting': 'Waiting for the first refresh…',
      'settings.unknown': 'TBD',
      'settings.update': 'Update {time}',
      'settings.preview': 'Preview {time}',
      'settings.refresh': 'Refresh now',
      'settings.refreshing': 'Refreshing…',
      'settings.started': 'Refresh started…',
      'settings.agent': 'Ask an Agent to verify',
      'settings.last': 'Last refresh: {time}',
      'settings.never': 'never',
      'settings.auto': 'Refreshes every 6 hours in the background; turning a game off removes the entries this plugin wrote for it.',
      'settings.watchOn': 'Weekly check on (Wednesdays 10:00 by an Agent)',
      'settings.watchOff': 'Weekly check off (needs the “automation” bundle)',
      'settings.error': 'Refresh failed: {message}',
      'settings.notice': 'notice',
      'settings.agentPrompt': [
        'Verify the official preview stream and version update times for Genshin Impact, Honkai: Star Rail, Zenless Zone Zero, Wuthering Waves, Arknights: Endfield and NTE.',
        'Start with gacha_schedule (action=list) to read its status summary, not official evidence; then use available search tools to check each game’s official Bilibili account for the latest update notice, preview teaser and dynamics.',
        'When an official time is explicit, write it with gacha_schedule (action=apply_official) using an ISO 8601 instant with offset; only touch the gacha entries, never other schedules.',
        'Endfield’s cadence is irregular — verify it carefully. If search is unavailable or evidence is insufficient, report that verification was not possible, not that nothing changed. Finish by enabling the fixed Wednesday 10:00 (Asia/Shanghai) check with gacha_schedule (action=watch).',
      ].join('\n'),
    }

    function detail(t, game) {
      if (!game.enabled) return t('settings.disabled')
      if (game.status === 'error') {
        return t('settings.error').replace('{message}', game.lastError ?? '')
      }
      if (game.plan === null) return t('settings.waiting')
      const plan = game.plan
      const approximate = plan.updateConfidence === 'inferred' || plan.previewConfidence === 'inferred'
        ? '≈ '
        : ''
      const version = plan.version === null ? '' : `${plan.version} · `
      const update = plan.updateStart === null ? t('settings.unknown') : short(plan.updateStart)
      const preview = plan.previewStart === null ? t('settings.unknown') : short(plan.previewStart)
      const warning = game.status === 'partial' && game.lastError !== null
        ? ` ⚠ ${game.lastError}`
        : ''
      return `${version}${approximate}${t('settings.update').replace('{time}', update)} · `
        + `${t('settings.preview').replace('{time}', preview)}${warning}`
    }

    function SettingsSection(props) {
      const { t, env } = props
      const [state, setState] = useState(null)
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState(false)
      const wasRefreshing = useRef(false)

      useEffect(() => { void load() }, [])

      async function load() {
        try {
          setState(await api.state())
        } catch (cause) {
          setStatus({ ok: false, text: cause.message })
        }
      }

      // A bulk write landing in the worker should repaint mounted calendars
      // immediately instead of waiting for the core's 20-second poll.
      useEffect(() => {
        if (wasRefreshing.current && state !== null && state.refreshing !== true) {
          notifyDataChanged()
        }
        wasRefreshing.current = state?.refreshing === true
      }, [state])

      // Poll only while the worker is running; the state flag is authoritative
      // because the refresh can outlive this card's mount. Depend on the whole
      // state object: `refreshing` stays true across polls, so it alone would
      // stop the chain after the first reload.
      useEffect(() => {
        if (state?.refreshing !== true || env?.timer === undefined) return undefined
        return env.timer.timeout(() => { void load() }, 2_500)
      }, [state])

      const toggle = async game => {
        setBusy(true)
        try {
          setState(await api.setEnabled(game.id, !game.enabled))
          notifyDataChanged()
          setStatus(null)
        } catch (cause) {
          setStatus({ ok: false, text: cause.message })
        } finally {
          setBusy(false)
        }
      }

      const refreshAll = async () => {
        setBusy(true)
        try {
          setState(await api.refresh())
          setStatus({ ok: true, text: t('settings.started') })
        } catch (cause) {
          setStatus({ ok: false, text: cause.message })
        } finally {
          setBusy(false)
        }
      }

      const openAgent = async () => {
        setBusy(true)
        setStatus(null)
        try {
          const created = await env.session.create({})
          if (!created.ok) throw created.error
          const sessionId = created.value.sessionId
          const prompted = await env.session.prompt({
            requestId: crypto.randomUUID(),
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: t('settings.agentPrompt') }],
          })
          if (!prompted.ok) throw prompted.error
          env.openSession(sessionId)
        } catch (cause) {
          setStatus({ ok: false, text: cause.message ?? String(cause) })
        } finally {
          setBusy(false)
        }
      }

      const games = state?.games ?? []
      const last = state?.lastRefreshAt === null || state?.lastRefreshAt === undefined
        ? t('settings.never')
        : short(state.lastRefreshAt)

      return h('div', { className: 'bsch-card' },
        h('h3', null, t('settings.title')),
        h('div', { className: 'bsch-hint' }, t('settings.hint')),
        h('div', null, ...games.map(game => h('div', { className: 'bsch-rowline', key: game.id },
          h('label', {
            style: {
              display: 'flex', alignItems: 'center', gap: '6px',
              minWidth: '170px', cursor: busy ? 'default' : 'pointer',
            },
          },
          h('input', {
            type: 'checkbox',
            checked: game.enabled,
            disabled: busy,
            onChange: () => void toggle(game),
          }),
          h('span', null, game.name)),
          h('span', {
            className: `bsch-hint${game.enabled && game.status === 'error' ? ' bsch-error' : ''}`,
            title: game.lastError ?? '',
            style: { flex: 1 },
          },
          detail(t, game),
          game.article?.url
            ? h('a', {
              href: game.article.url,
              target: '_blank',
              rel: 'noreferrer',
              style: { marginLeft: '6px' },
            }, t('settings.notice'))
            : null)))),
        h('div', { className: 'bsch-rowline' },
          h('button', {
            className: 'bsch-btn',
            disabled: busy || state?.refreshing === true,
            onClick: () => void refreshAll(),
          }, state?.refreshing === true ? t('settings.refreshing') : t('settings.refresh')),
          h('span', { className: 'bsch-spacer' }),
          h('button', {
            className: 'bsch-btn is-primary',
            disabled: busy,
            onClick: () => void openAgent(),
          }, t('settings.agent'))),
        h('div', { className: 'bsch-hint' }, t('settings.auto')),
        h('div', { className: 'bsch-hint' },
          `${t('settings.last').replace('{time}', last)} · `
          + (state?.watch?.enabled ? t('settings.watchOn') : t('settings.watchOff'))),
        status !== null
          ? h('div', { className: `bsch-hint${status.ok ? '' : ' bsch-error'}` }, status.text)
          : null)
    }

    return { SettingsSection, zh, en }
  },
})
