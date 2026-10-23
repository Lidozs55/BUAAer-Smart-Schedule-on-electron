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
      settled() {
        return Promise.resolve(options.outcome ?? 'ack')
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
      assert.equal(typeof state.textHandler, 'function', 'drop handler must be registered')
      state.textHandler(value.text)
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
