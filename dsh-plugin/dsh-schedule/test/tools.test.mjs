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

function fixture() {
  const maps = { entries: new Map(), tasks: new Map() }
  let global = { termStart: '', sourceState: {}, entryModelVersion: 2 }
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

test('Agent schema exposes optional location and lock, without old category or week projection', () => {
  const { spec, dispose, tools } = fixture()
  assert.equal(spec.parameters.location.type, 'string')
  assert.equal(spec.parameters.lock.type, 'boolean')
  assert.notEqual(spec.parameters.lock.required, true)
  assert.equal(spec.parameters.week_start, undefined)
  assert.equal(spec.parameters.category.enum.includes('course'), false)
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
