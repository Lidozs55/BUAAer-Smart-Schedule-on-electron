/**
 * ClipboardTab: the clipboard queue as the third tab of the schedule
 * panel (R8, reworked 2026-10-19: no longer a standalone sidebar panel).
 *
 * The queue mirrors the original design: a panel-level monitor polls
 * `navigator.clipboard.readText()` every few seconds, captures every new
 * non-empty text once, and prepends it to the queue. There is no "add
 * item" button — manual entry belongs in a session, not here.
 *
 * The queue is component-local module state (singleton, so it survives tab
 * switches but not a page reload — by design, it is scratch space).
 * "Send to new session" creates a session, admits the queue text as its
 * first prompt, and opens it (decision D-2: composer prefill is not
 * exposed to plugins in 0.2.0-rc.2, so the text rides the prompt itself).
 */
window.__ModuleLoader__.load({
  id: '@lidozs55/dsh-schedule/client.clipboard.js',
  factory: (require) => {
    const core = require('@lidozs55/dsh-schedule/client.core.js')
    const { React, h } = core
    const { useState, useEffect } = React
    const { ConfirmDialog } = core

    const MAX_QUEUE = 10
    const POLL_MS = 5000

    let queue = [] // module singleton across mounts
    let lastSeen = '' // last text captured, so one copy → one item
    const listeners = new Set()

    const emit = () => {
      for (const listener of [...listeners]) listener(queue)
    }
    const commit = next => {
      queue = next
      emit()
    }

    /** Capture one clipboard read. Returns true when it entered the queue. */
    const capture = text => {
      const value = typeof text === 'string' ? text.trim() : ''
      if (value === '' || value === lastSeen) return false
      lastSeen = value
      if (queue.includes(value)) return false
      commit([value, ...queue].slice(0, MAX_QUEUE))
      return true
    }

    const subscribe = listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    /**
     * Poll the system clipboard while the plugin is loaded (not just while
     * this tab is visible). The entry starts this globally via `ctx.effect`,
     * so copying from another panel/session still fills the queue. Browsers
     * may reject `readText` for permission/focus reasons; a failed read is
     * ignored and retried on the next tick, like the legacy app's monitor.
     */
    const startClipboardMonitor = (intervalMs = POLL_MS) => {
      let stopped = false
      let reading = false
      const tick = async () => {
        if (stopped || reading) return
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        reading = true
        try {
          const text = await navigator.clipboard.readText()
          if (!stopped) capture(text)
        } catch {
          // no permission / not focused / unsupported — retry next tick
        } finally {
          reading = false
        }
      }
      void tick()
      const id = setInterval(tick, intervalMs)
      return () => {
        stopped = true
        clearInterval(id)
      }
    }

    const assemble = items => [
      '请把下面每一条解析为日程项并落库（规则见 schedule skill）：',
      '- 有明确日期时间的用 sched_entry（action=batch_create）',
      '- 属于作业/考试/截止的用 sched_task（action=create）',
      '- 时间信息不完整的先向我确认，不要猜',
      ...items.map((item, index) => `${index + 1}. ${item}`),
    ].join('\n')

    /**
     * @param {object} props - slot props plus `env` whose `session` =
     *   `{ create, prompt }` and `openSession` are injected by the entry.
     */
    function ClipboardTab(props) {
      const { t, env } = props
      const { session, openSession } = env
      const [items, setItems] = useState(queue)
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState(false)
      const [confirming, setConfirming] = useState(false)

      useEffect(() => {
        const off = subscribe(setItems)
        setItems(queue) // capture can happen while this tab is unmounted
        return () => { off() }
      }, [])

      if (confirming) {
        return h(ConfirmDialog, {
          t, title: t('clipboard.clear'),
          message: t('clipboard.clearHint').replace('{count}', String(items.length)),
          confirmLabel: t('clipboard.clear'),
          onCancel: () => setConfirming(false),
          onConfirm: () => { setConfirming(false); commit([]) },
        })
      }

      const update = (index, value) => {
        const next = [...items]
        next[index] = value
        commit(next)
      }
      const remove = index => commit(items.filter((_, i) => i !== index))
      const move = (index, delta) => {
        const target = index + delta
        if (target < 0 || target >= items.length) return
        const next = [...items]
        const [row] = next.splice(index, 1)
        next.splice(target, 0, row)
        commit(next)
      }

      const send = async () => {
        setBusy(true)
        setStatus(null)
        try {
          const created = await session.create({})
          if (!created.ok) throw created.error
          const prompt = await session.prompt({
            requestId: crypto.randomUUID(),
            sessionId: created.value.sessionId,
            mode: 'queue',
            content: [{ type: 'text', text: assemble(items.filter(item => item.trim() !== '')) }],
          })
          if (!prompt.ok) throw prompt.error
          commit([])
          setStatus({ ok: true })
          env.openSession(created.value.sessionId)
        } catch (cause) {
          setStatus({ ok: false, message: cause.message ?? String(cause) })
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: 'bsch-body' },
        h('div', { className: 'bsch-toolbar' },
          h('span', { className: 'bsch-hint' }, t('clipboard.title')),
          h('span', { className: 'bsch-spacer' }),
          items.length > 0
            ? h('button', {
                className: 'bsch-btn is-danger', onClick: () => setConfirming(true),
              }, t('clipboard.clear'))
            : null),
        h('div', { className: 'bsch-hint', style: { padding: '0 8px 6px' } }, t('clipboard.hint')),
        h('div', { className: 'bsch-hint', style: { padding: '0 8px 6px' } },
          t('clipboard.watching')),
        items.length === 0
          ? h('div', { className: 'bsch-queue-empty' }, t('clipboard.empty'))
          : h('div', { className: 'bsch-queue' },
              items.map((item, index) => h('div', { className: 'bsch-queue-item', key: index },
                h('div', { className: 'bsch-queue-item-bar' },
                  h('button', { className: 'bsch-btn', title: t('clipboard.up'), onClick: () => move(index, -1) }, '↑'),
                  h('button', { className: 'bsch-btn', title: t('clipboard.down'), onClick: () => move(index, 1) }, '↓'),
                  h('button', { className: 'bsch-btn', title: t('clipboard.remove'), onClick: () => remove(index) }, '✕'),
                  h('span', { className: 'bsch-hint' }, `${index + 1}`)),
                h('textarea', {
                  className: 'bsch-textarea', rows: 2, value: item,
                  onChange: e => update(index, e.target.value),
                })))),
        items.length > 0 ? h('div', { className: 'bsch-preview' }, assemble(items)) : null,
        status !== null ? h('div', {
          className: `bsch-hint${status.ok ? '' : ' bsch-error'}`,
          style: { padding: '0 8px 4px' },
        }, status.ok ? t('clipboard.sent') : t('clipboard.sendFail').replace('{message}', status.message)) : null,
        h('div', { className: 'bsch-toolbar' },
          h('span', { className: 'bsch-spacer' }),
          h('button', {
            className: 'bsch-btn is-primary', disabled: busy || items.length === 0,
            onClick: () => void send(),
          }, t('clipboard.send'))))
    }

    return { ClipboardTab, startClipboardMonitor }
  },
})
