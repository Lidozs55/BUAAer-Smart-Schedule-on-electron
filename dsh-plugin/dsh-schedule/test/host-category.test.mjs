import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { registerHooks, createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { DEFAULT_CATEGORIES, cloneCategories } from '../host/model.js'
import { createScheduleService } from '../host/service.js'
import { migrateCategoryData, migrateEntryData, openScheduleDomain } from '../host/migrate.js'
import { importSchedulePayload } from '../host/import.js'
import { registerClientApi } from '../host/api.js'

const input = extra => ({ title: '日程', start: '2026-10-21T10:00:00+08:00', end: '2026-10-21T11:00:00+08:00', ...extra })
const custom = { id: 'custom-project', name: '项目', color: '#1122FF' }
const other = cloneCategories().find(row => row.id === 'other')
function fixture(global = { termStart: '', sourceState: {}, entryModelVersion: 2 }, initial = []) {
  const maps = { entries: new Map(initial.map(row => [row.id, row])), tasks: new Map() }
  const domain = {
    global: { get: () => global, set: async value => { global = value } },
    table: name => {
      maps[name] ??= new Map()
      return { get: id => maps[name].get(id), entries: () => maps[name].entries(), put: async (id, row) => { maps[name].set(id, row) }, delete: async id => maps[name].delete(id) }
    },
  }
  return { domain, service: createScheduleService({ logger: { warn() {} } }, domain) }
}

test('default definitions are independent and snapshots cannot mutate stored categories', async () => {
  assert.deepEqual(DEFAULT_CATEGORIES.map(row => row.id), ['course', 'homework', 'exam', 'meeting', 'study', 'sports', 'other'])
  const { service } = fixture()
  const meta = service.getMeta()
  meta.categories[0].name = 'changed'
  meta.categories.pop()
  assert.equal(service.getMeta().categories[0].name, '课程')
  const next = [...cloneCategories(), custom]
  await service.setCategories(next)
  next[0].name = 'changed'
  service.snapshot().global.categories[0].name = 'changed'
  assert.equal(service.getMeta().categories[0].name, '课程')
})

test('all presets except other can be removed; remapping preserves every non-category field', async () => {
  const { service } = fixture()
  await service.setCategories([...cloneCategories(), custom])
  const rows = []
  for (const category of service.getMeta().categories) {
    rows.push(await service.createEntry(input({ category: category.id, lock: true, location: '教室', source: 'buaa', sourceKey: category.id }), { allowConflicts: true }))
  }
  const renamed = service.getMeta().categories.map(row => row.id === custom.id ? { ...row, name: '新项目', color: '#ABCDEF' } : row)
  await service.setCategories(renamed)
  assert.deepEqual(service.listEntries(), rows)
  await service.setCategories([{ ...other, color: '#123456' }])
  assert.deepEqual(service.listEntries(), rows.map(row => ({ ...row, category: 'other' })))
  assert.deepEqual(service.getMeta().categories, [{ ...other, color: '#123456' }])
  await service.setMeta({ categories: cloneCategories(), termStart: '2026-09-07' })
  assert.equal(service.getMeta().categories.length, 1)
  for (const category of ['course', 'exam', custom.id, 'unknown']) {
    await assert.rejects(service.createEntry(input({ category })), error => error.code === 'invalid_input')
    await assert.rejects(service.updateEntry(rows[0].id, { category }), error => error.code === 'invalid_input')
  }
})

test('invalid category settings reject without changing definitions or entries', async () => {
  const { service } = fixture()
  const before = service.getMeta()
  for (const categories of [null, [], [custom], [{ ...other, name: 'Other' }], [other, other], [other, { ...custom, name: ' ' }], [other, { ...custom, color: '#123' }], [other, { ...custom, id: '' }]]) {
    await assert.rejects(service.setCategories(categories), error => error.code === 'invalid_input')
    assert.deepEqual(service.getMeta(), before)
  }
})

test('unknown and deleted snapshot categories fall back without restoring definitions', async () => {
  const { service } = fixture()
  await service.setCategories([other])
  await service.replaceSourceEntries('buaa', [input({ category: 'course', sourceKey: 'teaching:1' }), input({ category: 'not-known', sourceKey: 'exam:1' })])
  assert.ok(service.listEntries().every(row => row.category === 'other'))
  assert.deepEqual(service.getMeta().categories, [other])
})

test('category deletion serializes before and after entry/global/source mutations', async () => {
  const { service } = fixture()
  const created = service.createEntry(input({ category: 'course' }))
  const deleting = service.setCategories([other])
  const staleCreate = service.createEntry(input({ category: 'course' }), { allowConflicts: true })
  const outcome = Promise.allSettled([created, deleting, staleCreate, service.setMeta({ termStart: '2026-09-07' }), service.setSourceState('buaa', { ready: true }), service.replaceSourceEntries('buaa', [input({ category: 'course', sourceKey: 'one' })])])
  const results = await outcome
  assert.equal(results[0].status, 'fulfilled')
  assert.equal(results[2].status, 'rejected')
  assert.ok(service.listEntries().every(row => row.category === 'other'))
  assert.deepEqual(service.getMeta().categories, [other])
  assert.deepEqual(service.getSourceState('buaa'), { ready: true })
  const row = service.listEntries()[0]
  await Promise.all([service.updateEntry(row.id, { title: 'changed' }, { allowConflicts: true }), service.moveEntry({ id: row.id, start: '2026-10-22T10:00:00+08:00', end: '2026-10-22T11:00:00+08:00' })])
  assert.equal(service.listEntries().find(item => item.id === row.id).title, 'changed')
})

test('deletion failure leaves valid old definitions and can be retried', async () => {
  const { domain, service } = fixture()
  await service.createEntry(input({ category: 'course' }))
  const set = domain.global.set
  domain.global.set = async () => { throw new Error('disk failure') }
  const revision = service.currentRevision()
  const notifications = []
  service.subscribe(change => notifications.push(change))
  await assert.rejects(service.setCategories([other]), /disk failure/)
  assert.equal(service.listEntries()[0].category, 'other')
  assert.equal(service.getMeta().categories.length, 7)
  assert.equal(service.currentRevision(), revision + 1)
  assert.deepEqual(notifications[0].tables, ['entries'])
  domain.global.set = set
  await service.setCategories([other])
  assert.deepEqual(service.getMeta().categories, [other])
})

test('category migration is independently marked, BUAA teaching-only, and retry safe', async () => {
  const rows = [
    input({ id: 'teaching', category: 'study', source: 'buaa', sourceKey: 'teaching:math' }),
    input({ id: 'manual', category: 'study' }),
    input({ id: 'exam', category: 'study', source: 'buaa', sourceKey: 'exam:one' }),
  ]
  const { domain } = fixture({ termStart: '', sourceState: {}, entryModelVersion: 2 }, rows)
  const set = domain.global.set
  domain.global.set = async () => { throw new Error('marker failure') }
  await assert.rejects(migrateCategoryData(domain), /marker failure/)
  domain.global.set = set
  await migrateCategoryData(domain)
  assert.equal(domain.table('entries').get('teaching').category, 'course')
  assert.equal(domain.table('entries').get('manual').category, 'study')
  assert.equal(domain.table('entries').get('exam').category, 'study')
  assert.equal(domain.global.get().categoryModelVersion, 1)
  await domain.table('entries').put('teaching', { ...rows[0] })
  await migrateCategoryData(domain)
  assert.equal(domain.table('entries').get('teaching').category, 'study')
  const missing = fixture({ termStart: '', sourceState: {}, entryModelVersion: 2, categories: [other] }, rows)
  await migrateCategoryData(missing.domain)
  assert.ok([...missing.domain.table('entries').entries()].every(([, row]) => row.category === 'other'))
  assert.deepEqual(missing.domain.global.get().categories, [other])
})

test('legacy rules materialize course only when currently configured, otherwise other', async () => {
  const rule = { id: 'math', courseName: '数学', classroom: '101', dayOfWeek: 1, weekRange: '1', startTime: '08:00', endTime: '09:00', updatedAt: '2026-10-21T00:00:00Z' }
  for (const configured of [undefined, [other, custom]]) {
    const { domain } = fixture({ termStart: '2026-09-07', sourceState: {}, categories: configured })
    await domain.table('courses').put(rule.id, rule)
    await migrateEntryData(domain)
    const rows = [...domain.table('entries').entries()].map(([, row]) => row)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].category, configured ? 'other' : 'course')
    assert.deepEqual(domain.global.get().categories, configured)
  }
})

test('backup roundtrip restores deleted presets, order, UI exportedAt and custom definitions before rows', async () => {
  const source = fixture().service
  await source.setCategories([custom, { ...other, color: '#ABCDEF' }])
  const row = await source.createEntry(input({ category: custom.id, lock: true, location: '教室' }))
  await source.createTask({ title: '任务', due: row.end, taskType: 'homework', entryId: row.id })
  const payload = { exportedAt: new Date().toISOString(), global: source.getMeta(), entries: source.listEntries(), tasks: source.listTasks() }
  const target = fixture().service
  await importSchedulePayload(target, payload)
  assert.deepEqual(target.getMeta().categories, payload.global.categories)
  assert.equal(target.listEntries()[0].category, custom.id)
  assert.equal(target.listTasks()[0].entryId, target.listEntries()[0].id)
})

test('backup ID conflicts remap incoming rows without overwriting existing category semantics or other', async () => {
  const target = fixture().service
  await target.setCategories([other, { ...custom, name: '已有项目', color: '#FF0000' }])
  const existing = await target.createEntry(input({ category: custom.id }))
  const payload = { global: { categories: [{ ...other, color: '#000000' }, custom] }, entries: [input({ title: '导入', category: custom.id })] }
  await importSchedulePayload(target, payload)
  const categories = target.getMeta().categories
  assert.equal(categories.find(row => row.id === custom.id).name, '已有项目')
  assert.deepEqual(categories.find(row => row.id === 'other'), other)
  const imported = target.listEntries().find(row => row.title === '导入')
  assert.match(imported.category, /^custom-[0-9a-f-]{36}$/)
  assert.equal(categories.find(row => row.id === imported.category).name, custom.name)
  assert.equal(target.listEntries().find(row => row.id === existing.id).category, custom.id)
  const count = categories.length
  await importSchedulePayload(target, payload)
  assert.equal(target.getMeta().categories.length, count)
  assert.equal(target.listEntries().filter(row => row.title === '导入').length, 1)
})

test('HTTP exposes dedicated category settings and exports category definitions', async () => {
  const { service } = fixture()
  let route
  registerClientApi({ get: () => ({ fetch: { register: value => { route = value; return () => {} } } }), logger: { warn() {} } }, { service })
  const post = async body => (await route.fetch(new Request('http://localhost/api/schedule-core', { method: 'POST', body: JSON.stringify(body) }))).json()
  assert.equal((await post({ op: 'setCategories', categories: [other, custom] })).ok, true)
  const exported = await post({ op: 'export' })
  assert.deepEqual(exported.value.global.categories, [other, custom])
})

const checkout = process.env.DSH_CHECKOUT || 'D:/deepseek-harness'
const installedDomain = path.join(checkout, 'packages/storage/storage-domain/lib/index.js')
test('installed DSH domain validates actual open/reopen twice without stripping configured categories', { skip: !existsSync(installedDomain) && 'installed DSH dependencies unavailable' }, async () => {
  const require = createRequire(pathToFileURL(installedDomain))
  const hook = registerHooks({ resolve(name, context, next) {
    if (name === '@deepseek-ai/dsh-storage-domain') return { url: pathToFileURL(installedDomain).href, shortCircuit: true }
    if (name === 'zod') return { url: pathToFileURL(require.resolve('zod')).href, shortCircuit: true }
    return next(name, context)
  } })
  try {
    const { DomainFacility } = await import(pathToFileURL(installedDomain).href)
    let durable = { global: { termStart: '', sourceState: {}, entryModelVersion: 2 }, tables: { entries: { old: { ...input({ id: 'old', description: null, location: null, lock: true, category: 'study', source: 'buaa', sourceKey: 'teaching:math', updatedAt: '2026-10-21T00:00:00Z' }) } }, tasks: {} } }
    const backend = { kv: { open: async () => ({
      loadAll: async () => structuredClone(durable),
      putRecord: async (table, id, row) => { durable.tables[table] ??= {}; durable.tables[table][id] = structuredClone(row) },
      deleteRecord: async (table, id) => { delete durable.tables[table]?.[id] },
      setGlobal: async global => { durable.global = structuredClone(global) },
      close: async () => {},
    }) } }
    const facility = new DomainFacility({ storage: { backend: { get: () => backend } }, emit() {}, logger: { warn() {} } }, { backend: 'test', routes: {} })
    let domain = await openScheduleDomain(facility)
    assert.equal(domain.table('entries').get('old').category, 'course')
    const service = createScheduleService({ logger: { warn() {} } }, domain)
    await service.setCategories([other, custom])
    await service.createEntry(input({ title: 'custom', category: custom.id }), { allowConflicts: true })
    await domain.close()
    for (let iteration = 0; iteration < 2; iteration += 1) {
      domain = await openScheduleDomain(facility)
      assert.deepEqual(domain.global.get().categories, [other, custom])
      assert.equal(domain.global.get().categoryModelVersion, 1)
      assert.equal(domain.table('entries').get('old').category, 'other')
      assert.ok([...domain.table('entries').entries()].some(([, row]) => row.category === custom.id))
      await domain.close()
    }
    // Old stores can already have configured definitions but no new marker.
    durable.global = { ...durable.global, categoryModelVersion: undefined }
    durable.tables.entries.old.category = 'study'
    domain = await openScheduleDomain(facility)
    assert.deepEqual(domain.global.get().categories, [other, custom])
    assert.equal(domain.table('entries').get('old').category, 'other')
    await domain.close()
  } finally { hook.deregister() }
})
