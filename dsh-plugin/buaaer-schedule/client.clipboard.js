/**
 * ClipboardPanel: the `main` panel behind key `buaaer-clipboard` (R8).
 * The queue is component-local state (module singleton, so it survives
 * tab switches but not a page reload — by design, it is scratch space).
 * "Send to new session" creates a session, admits the queue text as its
 * first prompt, and opens it (decision D-2: composer prefill is not
 * exposed to plugins in 0.2.0-rc.2, so the text rides the prompt itself).
 */
window.__ModuleLoader__.load({
  id: '@buaaer/dsh-schedule/client.clipboard.js',
  factory: (require) => {
    const core = require('@buaaer/dsh-schedule/client.core.js')
    const { React, h } = core
    const { useState } = React

    let queue = [] // module singleton across mounts

    const assemble = items => [
      '请把下面每一条解析为日程项并落库：',
      '- 有明确日期时间的建成条目（buaaer_entry_batch_create）',
      '- 属于作业/考试/截止的建成任务（buaaer_task_create）',
      '- 时间信息不完整的先向我确认，不要猜',
      ...items.map((item, index) => `${index + 1}. ${item}`),
    ].join('\n')

    /**
     * @param {object} props - slot props plus `env` = `{ api }` and
     *   `session` = `{ create, prompt }` injected by the entry.
     */
    function ClipboardPanel(props) {
      const { t, env, session } = props
      const [items, setItems] = useState(queue)
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState(false)

      const commit = next => {
        queue = next
        setItems(next)
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

      const onPaste = event => {
        const text = event.clipboardData.getData('text')
        if (text === '' || items.length > 0) return
        event.preventDefault()
        commit(text.split(/\r?\n/).map(line => line.trim()).filter(line => line !== ''))
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

      return h('div', { className: 'bsch-panel', onPaste: onPaste },
        h('div', { className: 'bsch-toolbar' },
          h('span', { className: 'bsch-hint' }, t('clipboard.title')),
          h('span', { className: 'bsch-spacer' }),
          h('button', { className: 'bsch-btn', onClick: () => commit([...items, '']) }, t('clipboard.add'))),
        h('div', { className: 'bsch-hint', style: { padding: '0 8px 6px' } }, t('clipboard.hint')),
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

    return { ClipboardPanel }
  },
})
