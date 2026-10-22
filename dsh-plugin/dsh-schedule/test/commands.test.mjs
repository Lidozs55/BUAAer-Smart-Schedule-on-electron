import assert from 'node:assert/strict'
import test from 'node:test'
import { createCommandRegistry } from '../host/command-registry.js'
import { registerCoreCommands } from '../host/commands.js'
import { createScheduleService } from '../host/service.js'

function fixture(termStart = '', sourceState = {}) {
  const maps = { entries: new Map(), tasks: new Map() }
  let global = { termStart, sourceState, entryModelVersion: 2 }
  const service = createScheduleService({ logger: { warn() {} } }, {
    global: { get: () => global, set: async value => { global = value } },
    table: name => ({
      get: id => maps[name].get(id),
      entries: () => maps[name].entries(),
      put: async (id, row) => { maps[name].set(id, row) },
      delete: async id => maps[name].delete(id),
    }),
  })
  const registry = createCommandRegistry()
  registerCoreCommands(registry, service)
  return {
    service,
    registry,
    run: (path, input) => registry.execute(path, input, { source: 'cli' }),
  }
}

const input = extra => ({
  title: '日程',
  start: '2026-10-21T10:00:00+08:00',
  end: '2026-10-21T11:00:00+08:00',
  ...extra,
})

test('entry list exposes full rows, categories and term metadata even when empty', async () => {
  const { run, service } = fixture('2026-09-07')
  const args = { from: '2026-10-24T00:00:00+08:00', to: '2026-10-25T00:00:00+08:00' }
  const empty = await run(['entry', 'list'], args)
  assert.deepEqual(empty.entries, [])
  assert.deepEqual(empty.categories, service.getMeta().categories)
  assert.equal(empty.termStart, '2026-09-07')

  const created = await run(['entry', 'create'], input({
    title: '博雅活动',
    start: '2026-10-24T14:00:00+08:00',
    end: '2026-10-24T16:00:00+08:00',
    category: 'course',
    location: '主103',
    description: '授课教师：某老师',
    lock: true,
  }))
  const listed = await run(['entry', 'list'], args)
  assert.equal(listed.count, 1)
  assert.deepEqual(listed.entries, [created])
  assert.equal(listed.entries[0].week, 7)
  assert.equal(listed.entries[0].dayOfWeek, 6)
  assert.equal(listed.entries[0].location, '主103')
  assert.equal(listed.entries[0].description, '授课教师：某老师')
  assert.equal(listed.entries[0].lock, true)
})

test('create and update echo persisted fields with response-only teaching labels', async () => {
  const { run, service } = fixture('2026-09-07')
  const extra = { category: 'course', location: '主103', lock: true }
  const created = await run(['entry', 'create'], input(extra))
  assert.equal(typeof created.id, 'string')
  for (const key of ['title', 'start', 'end', 'category', 'location', 'lock']) {
    assert.equal(created[key], input(extra)[key])
  }
  assert.equal(created.week, 7)
  assert.equal(created.dayOfWeek, 3)
  const updated = await run(['entry', 'update'], {
    id: created.id,
    location: '',
    lock: false,
  })
  assert.equal(updated.id, created.id)
  assert.equal(updated.title, created.title)
  assert.equal(updated.location, null)
  assert.equal(updated.lock, false)
  assert.equal('week' in service.listEntries()[0], false)
  assert.equal('dayOfWeek' in service.listEntries()[0], false)
})

test('entry and task remind-lead set, clear and batch overrides', async () => {
  const { run } = fixture('2026-09-07')
  const entry = await run(['entry', 'create'], input({ 'remind-lead': 60 }))
  assert.equal(entry.remindLead, 60)
  const clearedEntry = await run(['entry', 'update'], { id: entry.id, 'remind-lead': -1 })
  assert.equal(clearedEntry.remindLead, null)

  const batch = await run(['entry', 'batch-create'], {
    entries: [input({
      title: '批量提醒',
      start: '2026-10-24T14:00:00+08:00',
      end: '2026-10-24T16:00:00+08:00',
      'remind-lead': 0,
    })],
  })
  assert.equal(batch.results[0].entry.remindLead, 0)

  const task = await run(['task', 'create'], {
    title: '提醒任务',
    due: '2026-10-25T23:59:00+08:00',
    'remind-lead': 1440,
  })
  assert.equal(task.remindLead, 1440)
  const clearedTask = await run(['task', 'update'], { id: task.id, 'remind-lead': -1 })
  assert.equal(clearedTask.remindLead, null)

  await assert.rejects(
    run(['entry', 'create'], input({ 'remind-lead': 10081 })),
    error => error.code === 'invalid_input' && /remind-lead/.test(error.message),
  )
})

test('teaching week follows the explicit entry date and is null before/without term start', async () => {
  for (const [termStart, start, end, week, weekday] of [
    ['2026-09-07', '2026-09-06T23:30:00+08:00', '2026-09-06T23:45:00+08:00', null, 7],
    ['2026-09-07', '2026-09-07T00:00:00+08:00', '2026-09-07T01:00:00+08:00', 1, 1],
    ['2026-09-07', '2026-10-26T00:00:00+08:00', '2026-10-26T01:00:00+08:00', 8, 1],
    ['', '2026-10-24T14:00:00+08:00', '2026-10-24T16:00:00+08:00', null, 6],
    ['2027-02-22', '2027-03-15T00:00:00+08:00', '2027-03-15T01:00:00+08:00', 4, 1],
    ['2026-09-07', '2026-10-26T00:00:00-07:00', '2026-10-26T01:00:00-07:00', 8, 1],
  ]) {
    const { run } = fixture(termStart)
    const row = await run(['entry', 'create'], input({ start, end }))
    assert.equal(row.week, week)
    assert.equal(row.dayOfWeek, weekday)
  }
})

test('conflicts are rejected with actionable details and do not write', async () => {
  const { run, service } = fixture('2026-09-07')
  const created = await run(['entry', 'create'], input({ location: '图书馆' }))
  const before = service.listEntries()
  await assert.rejects(
    run(['entry', 'create'], input({ title: '重叠活动' })),
    error => {
      assert.equal(error.code, 'conflict')
      assert.ok(error.details.conflicts.length > 0)
      assert.ok(error.details.conflicts[0].reason)
      assert.equal(error.details.conflicts[0].title, created.title)
      return true
    },
  )
  assert.deepEqual(service.listEntries(), before)
})

test('batch create keeps per-item results and complete successful rows', async () => {
  const { run } = fixture('2026-09-07')
  await run(['entry', 'create'], input({ title: '既定安排' }))
  const batch = await run(['entry', 'batch-create'], {
    entries: [
      input({ title: '冲突' }),
      input({
        title: '成功',
        start: '2026-10-24T14:00:00+08:00',
        end: '2026-10-24T16:00:00+08:00',
        location: '主103',
      }),
    ],
  })
  assert.equal(batch.okCount, 1)
  assert.equal(batch.total, 2)
  assert.equal(batch.results[0].ok, false)
  assert.ok(batch.results[0].conflicts.length > 0)
  assert.equal(batch.results[1].id, batch.results[1].entry.id)
  assert.equal(batch.results[1].entry.location, '主103')
  assert.equal(batch.results[1].entry.week, 7)
  assert.equal(batch.results[1].entry.dayOfWeek, 6)
  await assert.rejects(
    run(['entry', 'batch-create'], { entries: [null] }),
    error => error.code === 'invalid_input',
  )
  await assert.rejects(
    run(['entry', 'batch-create'], { entries: [input({ locaton: '主103' })] }),
    error => error.code === 'invalid_input' && /locaton/.test(error.message),
  )
})

test('all-day and conflict-rejected updates have complete results without changing rows', async () => {
  const { run, service } = fixture('2026-09-07')
  const row = await run(['entry', 'create'], {
    title: '全天活动',
    'all-day': true,
    start: '2026-10-24',
    location: '主楼',
  })
  assert.equal(row.allDay, true)
  assert.equal(row.week, 7)
  assert.equal(row.dayOfWeek, 6)
  const another = await run(['entry', 'create'], input())
  const before = service.listEntries()
  await assert.rejects(
    run(['entry', 'update'], { id: another.id, start: row.start, end: row.end }),
    error => error.code === 'conflict' && error.details.conflicts.length > 0,
  )
  assert.deepEqual(service.listEntries(), before)
})

test('task list uses rolling seven days and completed items require explicit inclusion', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-21T12:00:00+08:00') })
  const { run } = fixture()
  const rows = []
  for (const [title, due] of [
    ['overdue', '2026-10-20T12:00:00+08:00'],
    ['next-monday', '2026-10-26T12:00:00+08:00'],
    ['seven-day-edge', '2026-10-28T12:00:00+08:00'],
    ['beyond', '2026-10-28T12:00:01+08:00'],
  ]) rows.push(await run(['task', 'create'], { title, due }))
  assert.deepEqual(
    (await run(['task', 'list'], { scope: 'week' })).tasks.map(row => row.title),
    ['next-monday', 'seven-day-edge'],
  )
  assert.deepEqual(
    (await run(['task', 'list'], { scope: 'overdue' })).tasks.map(row => row.title),
    ['overdue'],
  )
  await run(['task', 'complete'], { id: rows[1].id })
  assert.deepEqual(
    (await run(['task', 'list'], { scope: 'week' })).tasks.map(row => row.title),
    ['seven-day-edge'],
  )
  assert.equal((await run(['task', 'list'], { scope: 'all', 'include-completed': true })).count, 4)
  await run(['task', 'complete'], { id: rows[1].id, completed: false })
  assert.equal((await run(['task', 'list'], { scope: 'week' })).count, 2)
})

test('task and entry references are independent and do not cascade', async () => {
  const { run } = fixture()
  const entry = await run(['entry', 'create'], input({ lock: true }))
  const task = await run(['task', 'create'], {
    title: 'related-task',
    due: '2026-10-25T23:59:00+08:00',
    'entry-id': entry.id,
  })
  assert.equal(task.entryId, entry.id)
  assert.equal((await run(['entry', 'list'])).entries[0].taskId, undefined)
  await run(['entry', 'update'], { id: entry.id, 'task-id': task.id })
  await run(['task', 'complete'], { id: task.id })
  assert.equal((await run(['entry', 'list'])).count, 1)
  const detached = await run(['task', 'update'], { id: task.id, 'entry-id': '' })
  assert.equal(detached.entryId, null)
  const detachedEntry = await run(['entry', 'update'], { id: entry.id, 'task-id': '' })
  assert.equal(detachedEntry.taskId, null)
  await run(['entry', 'delete'], { id: entry.id })
  const remaining = await run(['task', 'list'], { 'include-completed': true })
  assert.equal(remaining.count, 1)
  assert.equal(remaining.tasks[0].id, task.id)
  assert.equal(remaining.tasks[0].completed, true)
})

test('catalog is public data and help surfaces commands, options and guides', () => {
  const { registry } = fixture()
  const catalog = registry.catalog()
  assert.equal(catalog.version, 1)
  assert.deepEqual(catalog.commands.map(command => command.name), ['entry', 'task'])
  const entry = catalog.commands[0]
  assert.ok(entry.children.some(child => child.name === 'batch-create'))
  assert.ok(entry.children.every(child => typeof child.run === 'undefined'))
  const create = entry.children.find(child => child.name === 'create')
  assert.equal(create.options.find(option => option.name === 'allow-conflicts').type, 'boolean')
  assert.equal(create.options.find(option => option.name === 'remind-lead').type, 'integer')
  assert.ok(catalog.guides.some(guide => guide.name === 'workflow'))
  assert.ok(catalog.guides.every(guide => typeof guide.body === 'string' && guide.body.length > 0))
})

test('registry rejects unknown options, missing required values and unknown commands', async () => {
  const { run } = fixture()
  await assert.rejects(run(['entry', 'create'], { start: '2026-10-21' }), error => error.code === 'usage' && /title/.test(error.message))
  await assert.rejects(run(['entry', 'create'], { title: 'x', start: '2026-10-21', nope: true }), error => error.code === 'usage')
  await assert.rejects(run(['nope'], {}), error => error.code === 'unknown_command')
  await assert.rejects(run(['entry', 'create'], { title: 'x', start: '2026-10-21', 'task-type': 'x' }), error => error.code === 'usage')
})

test('source namespaces can register and unregister commands and guides independently', async () => {
  const { registry } = fixture()
  const dispose = registry.register({
    name: 'sample',
    summary: 'sample',
    commands: [{
      name: 'ping',
      summary: 'ping',
      options: { value: { type: 'string', required: true } },
      run: input => ({ pong: input.value }),
    }],
  })
  const disposeGuide = registry.registerGuide({
    name: 'sample',
    title: 'Sample',
    summary: 'sample guide',
    body: 'sample body',
  })
  assert.deepEqual(await registry.execute(['sample', 'ping'], { value: 'x' }), { pong: 'x' })
  assert.ok(registry.catalog().guides.some(guide => guide.name === 'sample'))
  dispose()
  disposeGuide()
  assert.equal(registry.resolve(['sample', 'ping']), undefined)
  assert.equal(registry.catalog().guides.some(guide => guide.name === 'sample'), false)
})
