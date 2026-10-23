import assert from 'node:assert/strict'
import test from 'node:test'
import { runSpocPoll } from '../host/sync.js'
import { normalizedTitle, spocTaskTitle, syncSpocTasks } from '../host/spoc-sync.js'

const assignment = (extra = {}) => ({
  assignmentId: 'a1',
  courseId: 'c1',
  courseName: '高等数学',
  teacherName: '张老师',
  title: '第三章习题',
  start: '2026-10-20T00:00:00.000Z',
  due: '2026-10-30T15:59:00.000Z',
  score: '100',
  status: 'unsubmitted',
  statusText: '未提交',
  ...extra,
})

const feed = (assignments, extra = {}) => ({
  termCode: '2026-2027-1',
  termName: '2026-2027 秋季学期',
  assignments,
  submitted: 0,
  skipped: 0,
  ...extra,
})

function harness({ tasks = [], state = {}, termStart = '2026-09-07' } = {}) {
  const rows = new Map(tasks.map(task => [task.id, structuredClone(task)]))
  let serial = 0
  const sourceState = structuredClone(state)
  const service = {
    getMeta: () => ({ termStart }),
    getSourceState: () => sourceState,
    setSourceState: async (_source, value) => {
      for (const key of Object.keys(sourceState)) delete sourceState[key]
      Object.assign(sourceState, structuredClone(value))
    },
    listTasks: () => [...rows.values()],
    createTask: async input => {
      const id = `t${++serial}`
      rows.set(id, { ...structuredClone(input), id })
      return rows.get(id)
    },
    updateTask: async (id, patch) => {
      const current = rows.get(id)
      assert.ok(current !== undefined, `missing task ${id}`)
      Object.assign(current, structuredClone(patch))
      return current
    },
    deleteTask: async id => { rows.delete(id) },
  }
  return { service, rows, sourceState }
}

test('task title pairs course and assignment; identity ignores case and spacing', () => {
  assert.equal(spocTaskTitle(assignment()), '高等数学 作业：第三章习题')
  assert.equal(
    normalizedTitle('  高等数学   作业：第三章习题 '),
    normalizedTitle('高等数学 作业:第三章习题'.replace(':', '：')),
  )
})

test('unsubmitted assignments become source-owned homework tasks', async () => {
  const h = harness()
  const summary = await syncSpocTasks(
    { service: h.service },
    feed([assignment()], { submitted: 3 }),
    { termStart: '2026-09-07' },
  )

  assert.deepEqual(summary, {
    created: 1, updated: 0, removed: 0, total: 1,
    submitted: 3, skipped: 0, duplicates: 0,
  })
  const [task] = [...h.rows.values()]
  assert.equal(task.title, '高等数学 作业：第三章习题')
  assert.equal(task.source, 'spoc')
  assert.equal(task.taskType, 'homework')
  assert.equal(task.due, '2026-10-30T15:59:00.000Z')
  assert.equal(task.description, '课程：高等数学；教师：张老师；满分：100')
})

test('a moved deadline updates the same task; a submitted assignment removes it', async () => {
  const h = harness()
  await syncSpocTasks({ service: h.service }, feed([assignment()]), { termStart: '2026-09-07' })
  const [created] = [...h.rows.values()]

  const moved = await syncSpocTasks(
    { service: h.service },
    feed([assignment({ due: '2026-11-02T15:59:00.000Z' })]),
    { termStart: '2026-09-07' },
  )
  assert.equal(moved.created, 0)
  assert.equal(moved.updated, 1)
  assert.equal(h.rows.size, 1)
  assert.equal(h.rows.get(created.id).due, '2026-11-02T15:59:00.000Z')

  const submitted = await syncSpocTasks(
    { service: h.service },
    feed([], { submitted: 1 }),
    { termStart: '2026-09-07' },
  )
  assert.equal(submitted.removed, 1)
  assert.equal(h.rows.size, 0)
})

test('a hand-written task with the same title only has its due corrected', async () => {
  const manual = {
    id: 'manual',
    title: '高等数学   作业：第三章习题',
    due: '2026-10-20T15:59:00.000Z',
    description: '我的笔记',
    priority: 'low',
    source: null,
    taskType: 'homework',
  }
  const h = harness({ tasks: [manual] })
  const summary = await syncSpocTasks({ service: h.service }, feed([assignment()]), {
    termStart: '2026-09-07',
  })

  assert.equal(summary.created, 0)
  assert.equal(summary.updated, 1)
  assert.equal(h.rows.size, 1)
  const task = h.rows.get('manual')
  assert.equal(task.due, '2026-10-30T15:59:00.000Z')
  assert.equal(task.description, '我的笔记')
  assert.equal(task.priority, 'low')
  assert.equal(task.title, manual.title)
})

test('deletion covers only this source and the current term', async () => {
  const h = harness({ tasks: [
    { id: 'gone', title: '高等数学 作业：旧作业', due: '2026-10-01T15:59:00.000Z', source: 'spoc' },
    { id: 'history', title: '高等数学 作业：上学期', due: '2026-01-01T15:59:00.000Z', source: 'spoc' },
    { id: 'foreign', title: '高等数学 作业：手建', due: '2026-10-01T15:59:00.000Z', source: null },
  ] })
  const summary = await syncSpocTasks({ service: h.service }, feed([]), {
    termStart: '2026-09-07',
  })

  assert.equal(summary.removed, 1)
  assert.deepEqual([...h.rows.keys()].sort(), ['foreign', 'history'])
})

test('without a term anchor nothing is deleted', async () => {
  const h = harness({ tasks: [
    { id: 'gone', title: '高等数学 作业：旧作业', due: '2026-10-01T15:59:00.000Z', source: 'spoc' },
  ] })
  const summary = await syncSpocTasks({ service: h.service }, feed([]), { termStart: '' })
  assert.equal(summary.removed, 0)
  assert.equal(h.rows.size, 1)
})

test('duplicate titles collapse to one task and keep the earliest deadline', async () => {
  const h = harness()
  const summary = await syncSpocTasks(
    { service: h.service },
    feed([
      assignment({ title: '习题', due: '2026-11-02T15:59:00.000Z' }),
      assignment({ title: '习题', due: '2026-10-25T15:59:00.000Z' }),
    ]),
    { termStart: '2026-09-07' },
  )
  assert.equal(summary.created, 1)
  assert.equal(summary.duplicates, 1)
  assert.equal([...h.rows.values()][0].due, '2026-10-25T15:59:00.000Z')
})

test('poll skips when disabled, sessionless or unanchored', async () => {
  const h = harness()
  let called = 0
  const spoc = {
    hasSession: () => true,
    refreshAssignments: async () => { called += 1; return feed([]) },
  }

  h.sourceState.spocEnabled = false
  assert.deepEqual(await runSpocPoll({ service: h.service, spoc }), { skipped: 'disabled' })

  delete h.sourceState.spocEnabled
  spoc.hasSession = () => false
  assert.deepEqual(await runSpocPoll({ service: h.service, spoc }), { skipped: 'no_session' })

  spoc.hasSession = () => true
  const unanchored = harness({ termStart: '' })
  assert.deepEqual(await runSpocPoll({ service: unanchored.service, spoc }), { skipped: 'no_term' })
  assert.equal(called, 0)
})

test('poll with a live session reconciles tasks and records the attempt', async () => {
  const h = harness()
  const spoc = {
    hasSession: () => true,
    refreshAssignments: async () => feed([assignment()]),
  }
  const summary = await runSpocPoll({ service: h.service, spoc })

  assert.equal(summary.created, 1)
  assert.equal(summary.termCode, '2026-2027-1')
  assert.equal(h.rows.size, 1)
  assert.equal(h.sourceState.spocTermCode, '2026-2027-1')
  assert.equal(h.sourceState.spocError, '')
  assert.match(h.sourceState.spocLastSyncAt, /^\d{4}-\d{2}-\d{2}T/)
})

test('disabling SPOC while a poll is fetching prevents writes and stale diagnostics', async () => {
  for (const fail of [false, true]) {
    const h = harness()
    let finish
    const spoc = {
      hasSession: () => true,
      refreshAssignments: () => new Promise((resolve, reject) => {
        finish = () => fail ? reject(new Error('late error')) : resolve(feed([assignment()]))
      }),
    }
    const pending = runSpocPoll({ service: h.service, spoc })
    h.sourceState.spocEnabled = false
    finish()
    assert.deepEqual(await pending, { skipped: 'disabled' })
    assert.equal(h.rows.size, 0)
    assert.equal(h.sourceState.spocError, undefined)
  }
})

test('poll refuses homework from a different configured account', async () => {
  const h = harness({ state: { buaaId: 'student-b' } })
  let fetched = false
  const spoc = {
    hasSession: () => true,
    sessionSnapshot: () => ({ username: 'student-a' }),
    refreshAssignments: async () => { fetched = true; return feed([assignment()]) },
  }
  assert.deepEqual(await runSpocPoll({ service: h.service, spoc }), { skipped: 'account_changed' })
  assert.equal(fetched, false)
  assert.equal(h.rows.size, 0)
})

test('a current-term SPOC feed cannot delete tasks under a historical term anchor', async () => {
  const h = harness({ tasks: [
    { id: 'history', title: '数学 作业：旧作业', due: '2026-10-01T15:59:00.000Z', source: 'spoc' },
  ] })
  const result = await runSpocPoll({ service: h.service, spoc: {
    hasSession: () => true,
    refreshAssignments: async () => feed([], { termCode: '2027-2028-1' }),
  } })
  assert.equal(result.code, 'term_mismatch')
  assert.equal(h.rows.has('history'), true)
})

test('SPOC and JW term-code formats can differ only in separators', async () => {
  const h = harness()
  const result = await runSpocPoll({ service: h.service, spoc: {
    hasSession: () => true,
    refreshAssignments: async () => feed([assignment()], { termCode: '2026-20271' }),
  } })
  assert.equal(result.created, 1)
})

test('poll records an error instead of throwing into the timer', async () => {
  const h = harness()
  const failure = Object.assign(new Error('SPOC 登录状态失效'), { code: 'auth' })
  const spoc = {
    hasSession: () => true,
    refreshAssignments: async () => { throw failure },
  }
  const result = await runSpocPoll({ service: h.service, spoc })

  assert.deepEqual(result, { failed: 'SPOC 登录状态失效', code: 'auth' })
  assert.equal(h.sourceState.spocError, 'SPOC 登录状态失效')
  assert.equal(h.rows.size, 0)
})
