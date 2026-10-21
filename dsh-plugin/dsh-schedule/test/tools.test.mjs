import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { createScheduleService } from '../host/service.js'

// Replace only the host registration envelope; exercise actual tool dispatch
// and service validation without requiring a running Cordis application.
const hook = registerHooks({
  resolve(name, context, next) {
    if (name === '@deepseek-ai/dsh-tools') return { url: 'data:text/javascript,export const defineTool = spec => spec', shortCircuit: true }
    return next(name, context)
  },
})
const { registerScheduleTools } = await import('../host/tools.js')
hook.deregister()

function fixture(termStart = '', sourceState = {}) {
  const maps = { entries: new Map(), tasks: new Map() }
  let global = { termStart, sourceState, entryModelVersion: 2 }
  const service = createScheduleService({ logger: { warn() {} } }, {
    global: { get: () => global, set: async value => { global = value } },
    table: name => ({ get: id => maps[name].get(id), entries: () => maps[name].entries(), put: async (id, row) => { maps[name].set(id, row) }, delete: async id => maps[name].delete(id) }),
  })
  const tools = new Map()
  const dispose = registerScheduleTools({ tools: { register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } } }, service)
  const spec = tools.get('sched_entry')
  return { service, spec, dispose, tools, execute: args => spec.execute(args, { signal: new AbortController().signal }) }
}
const input = extra => ({ title: '日程', start: '2026-10-21T10:00:00+08:00', end: '2026-10-21T11:00:00+08:00', ...extra })

// The host sends output.render blocks to the model, not execute's raw object.
const modelValue = (spec, args, value) => {
  const blocks = spec.output.render(args, value)
  return JSON.parse(blocks.at(-1).text)
}

test('Model-visible entry list includes full rows, current categories and term metadata even when empty', async () => {
  const { execute, spec, service } = fixture('2026-09-07')
  const args = { action: 'list', from: '2026-10-24T00:00:00+08:00', to: '2026-10-25T00:00:00+08:00' }
  const empty = modelValue(spec, args, await execute(args))
  assert.deepEqual(empty.entries, [])
  assert.deepEqual(empty.categories, service.getMeta().categories)
  assert.equal(empty.termStart, '2026-09-07')
  const created = await execute({ action: 'create', ...input({ title: '博雅活动', start: '2026-10-24T14:00:00+08:00', end: '2026-10-24T16:00:00+08:00', category: 'course', location: '主103', description: '授课教师：某老师', lock: true }) })
  const listed = modelValue(spec, args, await execute(args))
  assert.equal(listed.count, 1)
  assert.deepEqual(listed.entries, [created])
  assert.equal(listed.entries[0].week, 7)
  assert.equal(listed.entries[0].dayOfWeek, 6)
  assert.equal(listed.entries[0].location, '主103')
  assert.equal(listed.entries[0].description, '授课教师：某老师')
  assert.equal(listed.entries[0].lock, true)
  const other = service.getMeta().categories.find(row => row.id === 'other')
  await service.setCategories([other])
  assert.deepEqual(modelValue(spec, args, await execute(args)).categories, [other])
})

test('Model-visible create and update echo persisted fields with response-only teaching week labels', async () => {
  const { execute, spec, service } = fixture('2026-09-07')
  const args = { action: 'create', ...input({ category: 'course', location: '主103', lock: true }) }
  const created = modelValue(spec, args, await execute(args))
  assert.equal(typeof created.id, 'string')
  for (const key of ['title', 'start', 'end', 'category', 'location', 'lock']) assert.equal(created[key], args[key])
  assert.equal(created.week, 7)
  assert.equal(created.dayOfWeek, 3)
  const patch = { action: 'update', id: created.id, location: '', lock: false }
  const updated = modelValue(spec, patch, await execute(patch))
  assert.equal(updated.id, created.id)
  assert.equal(updated.title, created.title)
  assert.equal(updated.location, null)
  assert.equal(updated.lock, false)
  assert.equal(updated.week, 7)
  assert.equal('week' in service.listEntries()[0], false)
  assert.equal('dayOfWeek' in service.listEntries()[0], false)
})

test('Teaching week follows explicit entry calendar date and is null before or without term start', async () => {
  for (const [termStart, start, end, week, weekday] of [
    ['2026-09-07', '2026-09-06T23:30:00+08:00', '2026-09-06T23:45:00+08:00', null, 7],
    ['2026-09-07', '2026-09-07T00:00:00+08:00', '2026-09-07T01:00:00+08:00', 1, 1],
    ['2026-09-07', '2026-10-26T00:00:00+08:00', '2026-10-26T01:00:00+08:00', 8, 1],
    ['', '2026-10-24T14:00:00+08:00', '2026-10-24T16:00:00+08:00', null, 6],
    ['2027-02-22', '2027-03-15T00:00:00+08:00', '2027-03-15T01:00:00+08:00', 4, 1],
    ['2026-09-07', '2026-10-26T00:00:00-07:00', '2026-10-26T01:00:00-07:00', 8, 1],
  ]) {
    const { execute, spec } = fixture(termStart)
    const args = { action: 'create', ...input({ start, end }) }
    const row = modelValue(spec, args, await execute(args))
    assert.equal(row.week, week)
    assert.equal(row.dayOfWeek, weekday)
  }
})

test('Model-visible conflict and batch results retain reasons, ids and complete successful rows', async () => {
  const { execute, spec, service } = fixture('2026-09-07')
  const created = await execute({ action: 'create', ...input({ location: '图书馆' }) })
  const before = service.listEntries()
  const args = { action: 'create', ...input({ title: '重叠活动' }) }
  const rejected = modelValue(spec, args, await execute(args))
  assert.equal(rejected.ok, false)
  assert.ok(rejected.conflicts.length > 0)
  assert.ok(rejected.conflicts[0].reason)
  assert.equal(rejected.conflicts[0].title, created.title)
  assert.deepEqual(service.listEntries(), before)
  const batchArgs = { action: 'batch_create', entries: [input({ title: '冲突' }), input({ title: '成功', start: '2026-10-24T14:00:00+08:00', end: '2026-10-24T16:00:00+08:00', location: '主103' })] }
  const batch = modelValue(spec, batchArgs, await execute(batchArgs))
  assert.equal(batch.okCount, 1)
  assert.equal(batch.total, 2)
  assert.equal(batch.results[0].ok, false)
  assert.ok(batch.results[0].conflicts.length > 0)
  assert.equal(batch.results[1].id, batch.results[1].entry.id)
  assert.equal(batch.results[1].entry.location, '主103')
  assert.equal(batch.results[1].entry.week, 7)
  assert.equal(batch.results[1].entry.dayOfWeek, 6)
})

test('Tool output never exposes private source state alongside public metadata', async () => {
  const { execute, spec } = fixture('2026-09-07', { fixture: { password: 'fixture-only-secret' } })
  const args = { action: 'list' }
  const value = await execute(args)
  const serialized = JSON.stringify(spec.output.render(args, value))
  assert.equal(serialized.includes('fixture-only-secret'), false)
  assert.equal(serialized.includes('sourceState'), false)
  assert.deepEqual(Object.keys(modelValue(spec, args, value)).sort(), ['categories', 'count', 'entries', 'termStart'])
})

test('All-day and conflict-rejected updates have complete model-visible results without changing existing rows', async () => {
  const { execute, spec, service } = fixture('2026-09-07')
  const args = { action: 'create', title: '全天活动', all_day: true, start: '2026-10-24', location: '主楼' }
  const row = modelValue(spec, args, await execute(args))
  assert.equal(row.allDay, true)
  assert.equal(row.week, 7)
  assert.equal(row.dayOfWeek, 6)
  assert.equal(row.location, '主楼')
  const another = await execute({ action: 'create', ...input() })
  const before = service.listEntries()
  const patch = { action: 'update', id: another.id, start: row.start, end: row.end }
  const rejected = modelValue(spec, patch, await execute(patch))
  assert.equal(rejected.ok, false)
  assert.ok(rejected.conflicts.length > 0)
  assert.deepEqual(service.listEntries(), before)
})

test('Task tool model-visible results include list and mutation fields too', async () => {
  const { tools } = fixture()
  const spec = tools.get('sched_task')
  const run = args => spec.execute(args, { signal: new AbortController().signal })
  const args = { action: 'create', title: '作业', due: '2026-10-24T23:59:00+08:00', task_type: 'homework', description: '提交报告' }
  const row = modelValue(spec, args, await run(args))
  assert.equal(row.title, args.title)
  assert.equal(row.due, args.due)
  assert.equal(row.description, args.description)
  assert.equal(row.taskType, 'homework')
  const listArgs = { action: 'list' }
  assert.deepEqual(modelValue(spec, listArgs, await run(listArgs)).tasks, [row])
})

test('Agent schema exposes optional location and lock, with dynamic category ids and without week projection', () => {
  const { spec, dispose, tools } = fixture()
  assert.equal(spec.parameters.location.type, 'string')
  assert.equal(spec.parameters.lock.type, 'boolean')
  assert.notEqual(spec.parameters.lock.required, true)
  assert.equal(spec.parameters.week_start, undefined)
  assert.equal(spec.parameters.category.type, 'string')
  assert.equal(spec.parameters.category.enum, undefined)
  dispose()
  assert.equal(tools.size, 0)
})

test('Agent create/update/list/batch share location and lock semantics with UI service', async () => {
  const { execute } = fixture()
  const created = await execute({ action: 'create', ...input({ location: '图书馆', lock: true }) })
  assert.equal(created.lock, true)
  assert.equal(created.location, '图书馆')
  const updated = await execute({ action: 'update', id: created.id, location: '', lock: false })
  assert.equal(updated.lock, false)
  assert.equal(updated.location, null)
  const batch = await execute({ action: 'batch_create', allow_conflicts: true, entries: [input({ title: '第二条', lock: true, location: '主楼' }), input({ title: '第三条' })] })
  assert.equal(batch.okCount, 2)
  const listed = await execute({ action: 'list' })
  assert.equal(listed.count, 3)
  assert.equal('occurrences' in listed, false)
  assert.equal(listed.entries.find(row => row.title === '第三条').lock, false)
  assert.equal(listed.entries.find(row => row.title === '第二条').location, '主楼')
})

test('Agent discovers configured categories and accepts custom ids, rejecting removed ids', async () => {
  const { execute, service } = fixture()
  const custom = { id: 'custom-project', name: '项目', color: '#123456' }
  const other = service.getMeta().categories.find(row => row.id === 'other')
  await service.setCategories([other, custom])
  const listed = await execute({ action: 'list' })
  assert.deepEqual(listed.categories, [other, custom])
  assert.equal((await execute({ action: 'create', ...input({ category: custom.id }) })).category, custom.id)
  await assert.rejects(execute({ action: 'create', ...input({ category: 'course' }) }), /category/)
})


test('Documented task week is rolling seven days and completed items require explicit inclusion', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-21T12:00:00+08:00') })
  const { tools } = fixture()
  const spec = tools.get('sched_task')
  const run = async args => modelValue(spec, args, await spec.execute(args, { signal: new AbortController().signal }))
  const rows = []
  for (const [title, due] of [
    ['overdue', '2026-10-20T12:00:00+08:00'],
    ['next-monday', '2026-10-26T12:00:00+08:00'],
    ['seven-day-edge', '2026-10-28T12:00:00+08:00'],
    ['beyond', '2026-10-28T12:00:01+08:00'],
  ]) rows.push(await run({ action: 'create', title, due }))
  assert.deepEqual((await run({ action: 'list', scope: 'week' })).tasks.map(row => row.title), ['next-monday', 'seven-day-edge'])
  assert.deepEqual((await run({ action: 'list', scope: 'overdue' })).tasks.map(row => row.title), ['overdue'])
  await run({ action: 'complete', id: rows[1].id })
  assert.deepEqual((await run({ action: 'list', scope: 'week' })).tasks.map(row => row.title), ['seven-day-edge'])
  assert.equal((await run({ action: 'list', scope: 'all', include_completed: true })).count, 4)
  await run({ action: 'complete', id: rows[1].id, completed: false })
  assert.equal((await run({ action: 'list', scope: 'week' })).count, 2)
})

test('Documented entry window returns interval intersections rather than start-only matches', async () => {
  const { execute } = fixture()
  const batch = await execute({ action: 'batch_create', allow_conflicts: true, entries: [
    input({ title: 'ends-at-window', start: '2026-10-24T22:00:00+08:00', end: '2026-10-25T00:00:00+08:00' }),
    input({ title: 'spans-window', start: '2026-10-24T23:00:00+08:00', end: '2026-10-25T02:00:00+08:00' }),
    input({ title: 'starts-at-end', start: '2026-10-26T00:00:00+08:00', end: '2026-10-26T01:00:00+08:00' }),
  ] })
  assert.equal(batch.okCount, 3)
  const rows = await execute({ action: 'list', from: '2026-10-25T00:00:00+08:00', to: '2026-10-26T00:00:00+08:00' })
  assert.deepEqual(rows.entries.map(row => row.title), ['spans-window'])
})

test('Documented task-entry references are independent and do not cascade completion or deletion', async () => {
  const { execute, spec, tools } = fixture()
  const taskSpec = tools.get('sched_task')
  const task = args => taskSpec.execute(args, { signal: new AbortController().signal })
  const entry = await execute({ action: 'create', ...input({ lock: true }) })
  const todo = await task({ action: 'create', title: 'related-task', due: '2026-10-25T23:59:00+08:00', entry_id: entry.id })
  assert.equal(todo.entryId, entry.id)
  assert.equal((await execute({ action: 'list' })).entries[0].taskId, undefined)
  await execute({ action: 'update', id: entry.id, task_id: todo.id })
  await task({ action: 'complete', id: todo.id })
  assert.equal((await execute({ action: 'list' })).count, 1)
  const detached = await task({ action: 'update', id: todo.id, entry_id: '' })
  assert.equal(detached.entryId, null)
  const detachedEntry = modelValue(spec, { action: 'update' }, await execute({ action: 'update', id: entry.id, task_id: '' }))
  assert.equal(detachedEntry.taskId, null)
  await execute({ action: 'delete', id: entry.id })
  const remaining = await task({ action: 'list', include_completed: true })
  assert.equal(remaining.count, 1)
  assert.equal(remaining.tasks[0].id, todo.id)
  assert.equal(remaining.tasks[0].completed, true)
})
