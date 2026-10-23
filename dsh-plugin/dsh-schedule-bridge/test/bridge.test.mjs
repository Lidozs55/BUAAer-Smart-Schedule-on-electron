/**
 * schedule ⇄ vivarium bridge tests (docs 09 v2).
 *
 * The real bridge core (bridge.js) runs against a fake cordis context: the
 * host's timer/notice/task/drop surfaces are recorded, and the schedule
 * service is a plain object. This pins the contract edges (facts-only task
 * reports, reminder dedupe, drop staging and degradation) without needing
 * the DSH host or the schemastery peer.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { attachBridge } from '../bridge.js'

const flush = () => new Promise(resolve => setImmediate(resolve))

function harness(options = {}) {
  const state = {
    notices: [],
    reports: [],
    emits: [],
    warnings: [],
    infos: [],
    timers: [],
    cleanups: [],
    listeners: [],
    staged: [],
    confirmed: [],
    discarded: [],
    completed: [],
    dropsHandler: undefined,
    textHandler: undefined,
    events: new Map(),
    eventOptions: [],
    deliveredListeners: [],
  }

  const service = {
    getMeta: () => ({ termStart: '2026-09-07', categories: [] }),
    upcomingReminders: () => [],
    listTasks: () => [],
    subscribe(listener) {
      state.listeners.push(listener)
      return () => {
        const index = state.listeners.indexOf(listener)
        if (index >= 0) state.listeners.splice(index, 1)
      }
    },
    setTaskCompleted: async (id, completed) => {
      state.completed.push([id, completed])
    },
    dropbox: {
      stage(raw) {
        const drop = typeof raw === 'string' ? { text: raw } : raw
        if (drop === null || typeof drop !== 'object' || Array.isArray(drop)) return null
        const text = typeof drop.text === 'string' ? drop.text.trim() : ''
        if (text.length > 8_000) return null
        const images = Array.isArray(drop.images) ? drop.images : []
        if (text === '' && images.length === 0) return null
        const row = {
          id: `drop-${state.staged.length + 1}`,
          ...(text === '' ? {} : { text }),
          ...(images.length === 0 ? {} : { images }),
          at: '2026-10-22T00:00:00.000Z',
        }
        state.staged.push(row)
        return { ...row }
      },
      confirm(id) {
        const row = state.staged.find(candidate => candidate.id === id)
        if (row === undefined || row.confirmedAt !== undefined) return false
        row.confirmedAt = '2026-10-22T00:00:01.000Z'
        state.confirmed.push(id)
        return true
      },
      discard(id) {
        const index = state.staged.findIndex(candidate => candidate.id === id)
        if (index < 0) return false
        state.staged.splice(index, 1)
        state.discarded.push(id)
        return true
      },
      onDelivered(listener) {
        state.deliveredListeners.push(listener)
        return () => {
          const index = state.deliveredListeners.indexOf(listener)
          if (index >= 0) state.deliveredListeners.splice(index, 1)
        }
      },
    },
    ...options.service,
  }

  const vivarium = {
    every(ms, fn) {
      state.timers.push({ ms, fn })
      return () => {}
    },
    emit(signal) {
      state.emits.push(signal)
    },
    tasks: {
      report(facts) {
        state.reports.push(facts)
      },
    },
    notices: {
      post(request) {
        state.notices.push(request)
        return { ok: true, id: request.id }
      },
      settled(id) {
        const outcomes = options.settled ?? {}
        return Promise.resolve(outcomes[id] ?? options.outcome ?? 'ack')
      },
    },
    drops: {
      onDrop(handler) {
        state.dropsHandler = handler
        return () => {
          state.dropsHandler = undefined
        }
      },
      onText(handler) {
        state.textHandler = handler
        return () => {
          state.textHandler = undefined
        }
      },
    },
    ...options.vivarium,
  }

  const ctx = {
    scheduleCore: service,
    vivarium,
    logger: {
      warn: (...args) => state.warnings.push(args.map(String).join(' ')),
      info: (...args) => state.infos.push(args.map(String).join(' ')),
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') state.cleanups.push(dispose)
    },
    on(name, listener, listenerOptions) {
      state.events.set(name, listener)
      state.eventOptions.push({ name, ...listenerOptions })
      return () => {
        state.events.delete(name)
      }
    },
  }

  const config = {
    noticeOnReminder: true,
    statusSignals: true,
    dropToAgent: true,
    ...options.config,
  }
  attachBridge(ctx, config)

  return {
    state,
    service,
    config,
    emitDrop(drop) {
      const value = typeof drop === 'string' ? { text: drop } : drop
      if (typeof state.dropsHandler === 'function') {
        state.dropsHandler(value)
        return
      }
      assert.equal(typeof state.textHandler === 'function', true, 'drop handler must be registered')
      state.textHandler(value.text)
    },
    deliver(sessionId) {
      for (const listener of [...state.deliveredListeners]) listener(sessionId)
    },
    /** Invoke one registered waterfall listener; `delegated` tells whether it passed on. */
    ask(name, request) {
      const listener = state.events.get(name)
      assert.equal(typeof listener === 'function', true, `listener ${name} must be registered`)
      let delegated = false
      const result = listener(request, async () => {
        delegated = true
        return 'delegated'
      })
      return Promise.resolve(result).then(value => ({ value, delegated }))
    },
    fireTimer(ms) {
      for (const timer of state.timers.filter(candidate => candidate.ms === ms)) timer.fn()
    },
    cleanup() {
      for (const dispose of state.cleanups.splice(0)) dispose()
    },
  }
}

test('reminder window posts one notice, dedupes polls, and completes from the bubble', async () => {
  const due = new Date(Date.now() + 30_000).toISOString()
  const h = harness({
    outcome: 'complete',
    service: {
      upcomingReminders: () => [{
        kind: 'task',
        key: 'task-1',
        taskId: 'task-1',
        title: '实验报告',
        taskType: 'homework',
        due,
        at: due,
      }],
    },
  })

  assert.equal(h.state.notices.length, 1)
  const notice = h.state.notices[0]
  assert.equal(notice.id, 'sched-rem-task-1')
  assert.equal(notice.source, 'schedule-bridge')
  assert.match(notice.text, /实验报告/)
  assert.deepEqual(notice.actions.map(action => action.id), ['ack', 'complete'])

  await flush()
  assert.deepEqual(h.state.completed, [['task-1', true]])

  h.fireTimer(60_000)
  assert.equal(h.state.notices.length, 1) // raised-set dedupe, not a second bubble
})

test('entry reminders are informational (ack only) and outside the window stays silent', () => {
  const start = new Date(Date.now() + 20_000).toISOString()
  const later = new Date(Date.now() + 10 * 60_000).toISOString()
  const h = harness({
    service: {
      getMeta: () => ({ termStart: '2026-09-07', categories: [{ id: 'class', name: '课程' }] }),
      upcomingReminders: () => [
        { kind: 'entry', key: 'entry-1', title: '高数', category: 'class', start, at: start, allDay: false, location: '主楼' },
        { kind: 'task', key: 'task-later', taskId: 'task-later', title: '太早', taskType: 'other', due: later, at: later },
      ],
    },
  })
  assert.equal(h.state.notices.length, 1)
  assert.match(h.state.notices[0].text, /课程/)
  assert.match(h.state.notices[0].text, /主楼/)
  assert.deepEqual(h.state.notices[0].actions.map(action => action.id), ['ack'])
})

test('task reports are facts only: pending/overdue/next, no derived pet edges', () => {
  const overdueDue = new Date(Date.now() - 60_000).toISOString()
  const nextDue = new Date(Date.now() + 60 * 60_000).toISOString()
  const laterDue = new Date(Date.now() + 2 * 60 * 60_000).toISOString()
  const h = harness({
    service: {
      listTasks: () => [
        { id: 'a', title: '过期', due: overdueDue },
        { id: 'b', title: '下一项', due: nextDue },
        { id: 'c', title: '稍后', due: laterDue },
      ],
    },
  })

  const facts = h.state.reports.at(-1)
  assert.equal(facts.pending, 3)
  assert.equal(facts.overdue, 1)
  assert.deepEqual(facts.next, { title: '下一项', due: nextDue })
  assert.equal('overdue' in facts, true)
  // The bridge sends facts; the base owns tasks.overdue/tasks.clear.
  assert.equal(h.state.reports.length >= 1, true)
})

test('a change pulse emits the raw observability signal and refreshes facts', () => {
  const due = new Date(Date.now() + 60_000).toISOString()
  const h = harness({ service: { listTasks: () => [{ id: 'a', title: '作业', due }] } })
  h.state.reports.length = 0
  h.state.listeners[0]({ tables: ['tasks'], revision: 2 })
  assert.deepEqual(h.state.emits.at(-1), { type: 'sched.data.changed', payload: { tables: ['tasks'] } })
  assert.equal(h.state.reports.at(-1).pending, 1)
})

test('statusSignals=false skips task reports and the raw change signal', () => {
  const h = harness({
    config: { statusSignals: false },
    service: { listTasks: () => [{ id: 'a', title: '作业', due: new Date(Date.now() + 60_000).toISOString() }] },
  })
  assert.equal(h.state.reports.length, 0)
  h.state.listeners[0]({ tables: ['tasks'], revision: 1 })
  assert.equal(h.state.emits.length, 0)
})

test('missing tasks.report degrades with one warning instead of throwing', () => {
  const h = harness({ vivarium: { tasks: undefined } })
  assert.equal(h.state.reports.length, 0)
  assert.equal(h.state.warnings.some(line => line.includes('tasks.report')), true)
})

test('a dropped text is staged and confirmed from a direct-session bubble', async () => {
  const h = harness({ outcome: 'confirm' })
  h.emitDrop('  明天 14:00 交实验报告\n')
  assert.deepEqual(h.state.staged.map(row => row.text), ['明天 14:00 交实验报告'])
  const notice = h.state.notices.at(-1)
  assert.equal(notice.id, 'sched-drop-drop-1')
  assert.equal(notice.source, 'schedule-bridge')
  assert.equal(notice.ttlMs, 30_000)
  assert.match(notice.text, /直接新建会话/)
  assert.doesNotMatch(notice.text, /剪贴板/)
  assert.match(notice.text, /明天 14:00 交实验报告/)
  assert.deepEqual(notice.actions.map(action => action.id), ['confirm', 'deny'])
  await flush()
  assert.deepEqual(h.state.confirmed, ['drop-1'])
})

test('a dropped image is staged and summarized without base64 in the bubble', async () => {
  const h = harness({ outcome: 'deny' })
  const data = Buffer.from('png-bytes').toString('base64')
  h.emitDrop({ images: [{ mediaType: 'image/png', data, name: 'shot.png' }] })
  assert.deepEqual(h.state.staged.map(row => row.images), [[{ mediaType: 'image/png', data, name: 'shot.png' }]])
  const notice = h.state.notices.at(-1)
  assert.match(notice.text, /一张图片/)
  assert.match(notice.text, /shot\.png/)
  assert.doesNotMatch(notice.text, new RegExp(data.slice(0, 8)))
  assert.deepEqual(notice.actions.map(action => action.id), ['confirm', 'deny'])
  await flush()
  assert.deepEqual(h.state.discarded, ['drop-1'])
})

test('blank/oversized drops stage nothing and post no bubble', () => {
  const h = harness()
  h.emitDrop('   ')
  h.emitDrop('x'.repeat(8_001))
  h.emitDrop({ images: [] })
  assert.deepEqual(h.state.staged, [])
  assert.equal(h.state.notices.length, 0)
})

test('dropToAgent=false registers no subscriber and warns nothing', () => {
  const h = harness({ config: { dropToAgent: false } })
  assert.equal(h.state.dropsHandler, undefined)
  assert.equal(h.state.textHandler, undefined)
  assert.equal(h.state.warnings.length, 0)
})

test('an old base with only drops.onText still receives text drops', () => {
  const state = { handler: undefined }
  const h = harness({
    vivarium: {
      drops: {
        onText(handler) {
          state.handler = handler
          return () => { state.handler = undefined }
        },
      },
    },
    outcome: 'confirm',
  })
  assert.equal(h.state.dropsHandler, undefined)
  assert.equal(typeof state.handler, 'function')
  state.handler('旧基座文本')
  assert.deepEqual(h.state.staged.map(row => row.text), ['旧基座文本'])
  assert.match(h.state.notices.at(-1).text, /直接新建会话/)
})

test('a base without drops or a service without a confirmable dropbox degrades with a warning', () => {
  const noBase = harness({ vivarium: { drops: undefined } })
  assert.equal(noBase.state.dropsHandler, undefined)
  assert.equal(noBase.state.textHandler, undefined)
  assert.match(noBase.state.warnings.join('\n'), /drop hand-off unavailable/)

  const noService = harness({ service: { dropbox: undefined } })
  assert.equal(noService.state.dropsHandler, undefined)
  assert.match(noService.state.warnings.join('\n'), /drop hand-off unavailable/)

  const oldDropbox = harness({ service: { dropbox: { stage: () => ({ id: 'x' }) } } })
  assert.equal(oldDropbox.state.dropsHandler, undefined)
  assert.match(oldDropbox.state.warnings.join('\n'), /drop hand-off unavailable/)
})

test('a throwing dropbox.stage or notice.post is isolated and logged', () => {
  const stageFailure = harness({ service: { dropbox: {
    stage: () => { throw new Error('storage gone') },
    confirm: () => true,
    discard: () => true,
  } } })
  assert.doesNotThrow(() => stageFailure.emitDrop('hello'))
  assert.match(stageFailure.state.warnings.join('\n'), /drop staging failed/)
  assert.equal(stageFailure.state.notices.length, 0)

  const noticeFailure = harness({ vivarium: { notices: { post: () => { throw new Error('bubble gone') }, settled: () => Promise.resolve('ack') } } })
  assert.doesNotThrow(() => noticeFailure.emitDrop('hello'))
  assert.deepEqual(noticeFailure.state.staged, [])
  assert.deepEqual(noticeFailure.state.discarded, ['drop-1'])
  assert.match(noticeFailure.state.warnings.join('\n'), /drop notice failed/)
})

test('effect cleanup detaches the drop subscriber', () => {
  const h = harness()
  assert.equal(typeof h.state.dropsHandler, 'function')
  h.cleanup()
  assert.equal(h.state.dropsHandler, undefined)
})

// -- session question relay (docs 09 §2.4) ------------------------------------

const question = (request = {}, item = {}) => ({
  agent: { session: 'sess-1' },
  questions: [{
    id: 'when',
    question: '安排在 10 月 24 日 14:00，可以吗？',
    options: [{ label: '可以' }, { label: '不合适' }],
  }],
  ...request,
  ...(Object.keys(item).length === 0 ? {} : { questions: [{
    id: 'when',
    question: '安排在 10 月 24 日 14:00，可以吗？',
    options: [{ label: '可以' }, { label: '不合适' }],
    ...item,
  }] }),
})

test("a delivered session's two-option question is claimed and answered from the pet", async () => {
  const h = harness({ settled: { 'sched-ask-1': 'confirm' } })
  h.deliver('sess-1')
  const { value, delegated } = await h.ask('user-questions/request', question())
  assert.equal(delegated, false)
  assert.deepEqual(value, { answers: [{ id: 'when', selected: ['可以'] }] })
  const notice = h.state.notices.at(-1)
  assert.equal(notice.source, 'schedule-bridge')
  assert.equal(notice.ttlMs, 60_000)
  assert.match(notice.text, /10 月 24 日 14:00/)
  // The buttons carry the question's own option labels; the ids stay the
  // base's confirm/deny pair so species postures still fire.
  assert.deepEqual(notice.actions.map(action => action.id), ['confirm', 'deny'])
  assert.deepEqual(notice.actions.map(action => action.label.zh), ['可以', '不合适'])
})

test('tapping the second option answers with that label, not a guessed no', async () => {
  const h = harness({ settled: { 'sched-ask-1': 'deny' } })
  h.deliver('sess-1')
  const { value, delegated } = await h.ask('user-questions/request', question())
  assert.equal(delegated, false)
  assert.deepEqual(value, { answers: [{ id: 'when', selected: ['不合适'] }] })
})

test('an unanswered question bubble delegates to the session UI', async () => {
  const h = harness({ settled: { 'sched-ask-1': 'expired' } })
  h.deliver('sess-1')
  const { value, delegated } = await h.ask('user-questions/request', question())
  assert.equal(delegated, true)
  assert.equal(value, 'delegated')
  assert.equal(h.state.notices.length, 1) // the ask did surface on the pet first
})

test('sessions that were never delivered (or whose watch lapsed) are not claimed', async () => {
  const h = harness()
  const stranger = await h.ask('user-questions/request', question({ agent: { session: 'sess-x' } }))
  assert.equal(stranger.delegated, true)
  assert.equal(h.state.notices.length, 0)

  const realNow = Date.now
  try {
    h.deliver('sess-1')
    Date.now = () => realNow() + 11 * 60_000
    const lapsed = await h.ask('user-questions/request', question())
    assert.equal(lapsed.delegated, true)
    assert.equal(h.state.notices.length, 0)
  } finally {
    Date.now = realNow
  }
})

test('question shapes the pet cannot answer are delegated, not claimed', async () => {
  const h = harness()
  h.deliver('sess-1')
  const shapes = [
    question({ questions: [
      { id: 'a', question: '一', options: [{ label: 'x' }, { label: 'y' }] },
      { id: 'b', question: '二', options: [{ label: 'x' }, { label: 'y' }] },
    ] }),
    question({}, { options: undefined }),
    question({}, { options: [{ label: '1' }, { label: '2' }, { label: '3' }] }),
    question({}, { multiSelect: true }),
    question({ agent: undefined }),
  ]
  for (const shape of shapes) {
    const { delegated } = await h.ask('user-questions/request', shape)
    assert.equal(delegated, true)
  }
  assert.equal(h.state.notices.length, 0)
})

test("a delivered session's approval is claimed: allow on confirm, reject on deny", async () => {
  const allowed = harness({ settled: { 'sched-ask-1': 'confirm' } })
  allowed.deliver('sess-1')
  const yes = await allowed.ask('approval/request', {
    agent: { session: 'sess-1' }, toolName: 'run', reason: 'schedule entry create',
  })
  assert.deepEqual(yes, { value: 'allowed-once', delegated: false })
  assert.match(allowed.state.notices.at(-1).text, /schedule entry create/)

  const denied = harness({ settled: { 'sched-ask-1': 'deny' } })
  denied.deliver('sess-1')
  const no = await denied.ask('approval/request', { agent: { session: 'sess-1' }, toolName: 'run' })
  assert.deepEqual(no, { value: 'rejected', delegated: false })
})

test('an unanswered approval bubble delegates to the session UI', async () => {
  const h = harness({ settled: { 'sched-ask-1': 'expired' } })
  h.deliver('sess-1')
  const { value, delegated } = await h.ask('approval/request', {
    agent: { session: 'sess-1' }, toolName: 'run',
  })
  assert.equal(delegated, true)
  assert.equal(value, 'delegated')
})

test('an old core without dropbox.onDelivered keeps drops but warns about the relay', () => {
  const h = harness({ service: { dropbox: {
    stage: raw => ({ id: raw?.text ?? 'x', ...raw }),
    confirm: () => true,
    discard: () => true,
  } } })
  assert.equal(typeof h.state.dropsHandler === 'function', true)
  assert.deepEqual([...h.state.events.keys()], [])
  assert.match(h.state.warnings.join('\n'), /dropbox\.onDelivered/)
})

test('relay listeners are prepended and detached on cleanup', () => {
  const h = harness()
  assert.equal(h.state.eventOptions.length, 2)
  assert.deepEqual(h.state.eventOptions.map(option => option.prepend), [true, true])
  h.cleanup()
  assert.deepEqual([...h.state.events.keys()], [])
})

test('a notice post failure delegates instead of holding the request', async () => {
  const h = harness({ vivarium: { notices: {
    post: () => { throw new Error('bubble gone') },
    settled: () => Promise.resolve('confirm'),
  } } })
  h.deliver('sess-1')
  const { delegated } = await h.ask('user-questions/request', question())
  assert.equal(delegated, true)
})
