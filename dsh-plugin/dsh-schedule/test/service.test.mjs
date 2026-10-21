import assert from 'node:assert/strict'
import test from 'node:test'
import { createScheduleService } from '../host/service.js'
import { materializeEntries, migrateEntryData } from '../host/migrate.js'
import { importSchedulePayload } from '../host/import.js'

function memoryDomain(initial = {}) {
  const tables = new Map(Object.entries(initial.tables ?? {}).map(([name, rows]) => [name, new Map(rows.map(row => [row.id, row]))]))
  let global = initial.global ?? { termStart: '2026-09-07', sourceState: {}, entryModelVersion: 2 }
  return {
    global: { get: () => global, set: async value => { global = value } },
    table(name) {
      if (!tables.has(name)) tables.set(name, new Map())
      const rows = tables.get(name)
      return { get: id => rows.get(id), entries: () => [...rows].values(), put: async (id, row) => { rows.set(id, row) }, delete: async id => rows.delete(id) }
    },
  }
}
const makeService = () => createScheduleService({ logger: { warn() {} } }, memoryDomain())
const input = (extra = {}) => ({ title: '学习', start: '2026-10-21T08:00:00+08:00', end: '2026-10-21T09:00:00+08:00', ...extra })

test('entry defaults, location and strict boolean lock survive update and import', async () => {
  const service = makeService()
  const row = await service.createEntry(input())
  assert.equal(row.lock, false)
  assert.equal(row.location, null)
  assert.equal(row.category, 'other')
  const locked = await service.updateEntry(row.id, { lock: true, location: ' 主楼 101 ' })
  assert.equal(locked.location, '主楼 101')
  assert.equal(locked.lock, true)
  await assert.rejects(service.updateEntry(row.id, { lock: 'false' }), /lock/)
  const other = makeService()
  const counts = await importSchedulePayload(other, { entries: [locked] })
  assert.equal(counts.entries.created, 1)
  assert.equal(other.listEntries()[0].lock, true)
  assert.equal(other.listEntries()[0].location, '主楼 101')
  assert.equal((await service.updateEntry(row.id, { location: '' })).location, null)
})

test('lock does not restrict explicit update, move, conflict detection or deletion', async () => {
  const service = makeService()
  const row = await service.createEntry(input({ lock: true }))
  await assert.rejects(service.createEntry(input()), error => error.code === 'conflict')
  await service.updateEntry(row.id, { title: '改名' })
  await service.moveEntry({ id: row.id, start: '2026-10-22T10:00:00+08:00', end: '2026-10-22T11:00:00+08:00' })
  assert.equal(service.listEntries()[0].lock, true)
  await service.deleteEntry(row.id)
  assert.equal(service.listEntries().length, 0)
})

test('source snapshot preserves IDs, removes only own missing rows and validates before writes', async () => {
  const service = makeService()
  const manual = await service.createEntry(input())
  assert.deepEqual(await service.replaceSourceEntries('buaa', [input({ sourceKey: 'one', lock: true })]), { created: 1, updated: 0, cleared: 0, total: 1 })
  const first = service.listEntries().find(row => row.source === 'buaa')
  await service.replaceSourceEntries('buaa', [input({ sourceKey: 'one', title: '新标题', location: '地点', lock: true })])
  assert.equal(service.listEntries().find(row => row.source === 'buaa').id, first.id)
  await assert.rejects(service.replaceSourceEntries('buaa', [input({ sourceKey: 'valid' }), input({ sourceKey: 'bad', end: 'invalid' })]))
  assert.equal(service.listEntries().find(row => row.source === 'buaa').id, first.id)
  assert.equal(service.listEntries().length, 2)
  await service.replaceSourceEntries('buaa', [])
  assert.deepEqual(service.listEntries().map(row => row.id), [manual.id])
})

test('source snapshots clean all duplicate prior identities, including an empty cancellation', async () => {
  const domain = memoryDomain()
  const service = createScheduleService({ logger: { warn() {} } }, domain)
  await service.createEntry(input({ source: 'buaa', sourceKey: 'same' }), { allowConflicts: true })
  await service.createEntry(input({ source: 'buaa', sourceKey: 'same' }), { allowConflicts: true })
  await service.replaceSourceEntries('buaa', [input({ sourceKey: 'same' })])
  assert.equal(service.listEntries().length, 1)
  await service.createEntry(input({ source: 'buaa', sourceKey: 'same' }), { allowConflicts: true })
  await service.replaceSourceEntries('buaa', [])
  assert.equal(service.listEntries().length, 0)
})

test('full-term expansion honors sparse weeks, moved and canceled exceptions without teacher', () => {
  const rule = { id: 'a', courseName: '数学', classroom: '101', teacher: 'discard', dayOfWeek: 1, weekRange: '1,3-4', startTime: '08:00', endTime: '09:00', updatedAt: '2026-10-21T00:00:00Z' }
  const rows = materializeEntries([rule], [
    { courseId: 'a', baseDay: '2026-09-21', courseName: '数学补课', classroom: '102', start: '2026-10-01T10:00:00+08:00', end: '2026-10-01T11:00:00+08:00' },
    { courseId: 'a', baseDay: '2026-09-28', canceled: true },
  ], '2026-09-07')
  assert.deepEqual(rows.map(row => row.start), ['2026-09-07T08:00:00+08:00', '2026-10-01T10:00:00+08:00'])
  assert.equal(rows[1].location, '102')
  assert.ok(rows.every(row => row.lock && row.category === 'course' && !('teacher' in row)))
  assert.throws(() => materializeEntries([rule], [], ''), /学期/)
})

test('migration is restartable and never removes rules on an entry write failure', async () => {
  const rule = { id: 'a', courseName: '数学', classroom: '', dayOfWeek: 1, weekRange: '1-2', startTime: '08:00', endTime: '09:00', updatedAt: '2026-10-21T00:00:00Z' }
  const domain = memoryDomain({ global: { termStart: '2026-09-07', sourceState: {} }, tables: { courses: [rule], entries: [input({ id: 'manual', description: null, category: 'other' })] } })
  const table = domain.table.bind(domain)
  let attempts = 0
  domain.table = name => {
    const handle = table(name)
    if (name !== 'entries') return handle
    return { ...handle, put: async (...args) => { if (++attempts === 3) throw new Error('disk failure'); await handle.put(...args) } }
  }
  await assert.rejects(migrateEntryData(domain), /disk failure/)
  assert.equal([...table('courses').entries()].length, 1)
  domain.table = table
  await migrateEntryData(domain)
  assert.equal([...table('entries').entries()].length, 3)
  assert.equal([...table('courses').entries()].length, 0)
  await migrateEntryData(domain)
  assert.equal([...table('entries').entries()].length, 3)
  assert.equal(domain.global.get().entryModelVersion, 2)
})

test('migration retries partial rule deletion without duplicating overlapping semantic identities', async () => {
  const rule = { id: 'a', courseName: '数学', classroom: '', dayOfWeek: 1, weekRange: '1-3', startTime: '08:00', endTime: '09:00', updatedAt: '2026-10-21T00:00:00Z' }
  const domain = memoryDomain({ global: { termStart: '2026-09-07', sourceState: {} }, tables: { courses: [rule, { ...rule, id: 'b', weekRange: '3-5' }] } })
  const table = domain.table.bind(domain)
  let deletes = 0
  domain.table = name => {
    const handle = table(name)
    if (name !== 'courses') return handle
    return { ...handle, delete: async id => { if (++deletes === 2) throw new Error('delete failure'); return handle.delete(id) } }
  }
  await assert.rejects(migrateEntryData(domain), /delete failure/)
  assert.equal([...table('entries').entries()].length, 5)
  assert.equal([...table('courses').entries()].length, 1)
  domain.table = table
  await migrateEntryData(domain)
  assert.equal([...table('entries').entries()].length, 5)
  assert.equal([...table('courses').entries()].length, 0)
  assert.equal(domain.global.get().entryModelVersion, 2)
})

test('migration retries a failed final marker write without losing or duplicating rows', async () => {
  const domain = memoryDomain({ global: { termStart: '2026-09-07', sourceState: {} }, tables: { courses: [{ id: 'a', courseName: '数学', classroom: '', dayOfWeek: 1, weekRange: '1-2', startTime: '08:00', endTime: '09:00', updatedAt: '2026-10-21T00:00:00Z' }] } })
  const set = domain.global.set
  domain.global.set = async () => { throw new Error('marker failure') }
  await assert.rejects(migrateEntryData(domain), /marker failure/)
  assert.equal([...domain.table('entries').entries()].length, 2)
  assert.equal([...domain.table('courses').entries()].length, 0)
  domain.global.set = set
  await migrateEntryData(domain)
  assert.equal([...domain.table('entries').entries()].length, 2)
  assert.equal(domain.global.get().entryModelVersion, 2)
})

test('unsupported legacy import fields and malformed table lists reject before writing metadata', async () => {
  const service = makeService()
  for (const payload of [{ courses: [], global: { termStart: '2027-02-22' } }, { entries: {} }, { tasks: 'invalid' }]) {
    await assert.rejects(importSchedulePayload(service, payload), error => error.code === 'invalid_input')
  }
  assert.equal(service.listEntries().length, 0)
  assert.equal(service.getMeta().termStart, '2026-09-07')
})

test('snapshot and new export import no longer expose separate teaching types', async () => {
  const service = makeService()
  await service.createEntry(input({ location: '机房', lock: true }))
  const snapshot = service.snapshot({ weekStart: '2026-10-21' })
  assert.equal(snapshot.entries.length, 1)
  assert.equal('courses' in snapshot, false)
  assert.equal('occurrences' in snapshot, false)
  assert.equal(service.weekOccurrences, undefined)
  assert.equal(service.replaceCourses, undefined)
  assert.equal((await service.createEntry(input({ category: 'course' }), { allowConflicts: true })).category, 'course')
})
