import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTimetable, parseExams } from '../host/parse.js'
import { runSync } from '../host/sync.js'
import { createScheduleService } from '../../dsh-schedule/host/service.js'
import { createGachaService } from '../../dsh-schedule-gacha/host/service.js'

const cell = (extra = {}) => ({ courseName: '数学', dayOfWeek: 2, beginTime: '08:00', endTime: '09:35', placeName: 'A101', weeksAndTeachers: '1-3周(单)[理论]/张老师[主讲]', ...extra })
const payload = (...items) => ({ datas: { code: '23370001', arrangedList: items, practiceList: [] } })
const exam = (extra = {}) => ({ courseName: '数学', examDate: '2026-11-10 00:00:00', startTime: '14:00', endTime: '16:00', examPlace: 'B202', examSeatNo: '12', ...extra })

function harness({ schedule = payload(cell()), exams = [exam()], failure } = {}) {
  const entries = new Map()
  const tasks = new Map()
  const states = { buaa: { buaaId: '23370001' } }
  const meta = { termStart: '2026-09-07' }
  let serial = 0
  const calls = []
  const service = {
    getMeta: () => meta,
    setMeta: async patch => Object.assign(meta, patch),
    getSourceState: source => states[source] ?? {},
    setSourceState: async (source, state) => { states[source] = structuredClone(state) },
    listEntries: () => [...entries.values()],
    replaceSourceEntries: async (source, inputs) => {
      calls.push(structuredClone({ source, inputs }))
      let created = 0, updated = 0, cleared = 0
      const remaining = new Set(inputs.map(input => input.sourceKey))
      for (const input of inputs) {
        const current = [...entries.values()].find(row => row.source === source && row.sourceKey === input.sourceKey)
        if (!current) { const id = `e${++serial}`; entries.set(id, { ...input, source, id }); created++ }
        else if (Object.keys(input).some(key => input[key] !== current[key])) { entries.set(current.id, { ...current, ...input }); updated++ }
      }
      for (const [id, row] of entries) if (row.source === source && !remaining.has(row.sourceKey)) { entries.delete(id); cleared++ }
      return { created, updated, cleared, total: inputs.length }
    },
    listTasks: () => [...tasks.values()],
    createTask: async input => { const id = `t${++serial}`; tasks.set(id, { ...input, id }); return tasks.get(id) },
    updateTask: async (id, patch) => { Object.assign(tasks.get(id), patch) },
    deleteTask: async id => { tasks.delete(id) },
  }
  const jw = { ssoLogin: async () => ({}), fetchSchedule: async () => schedule, fetchExams: async () => { if (failure) throw failure; return { datas: exams } } }
  return { service, jw, entries, tasks, states, calls, sync: () => runSync({ service, jw }, { password: 'test-only' }) }
}

test('explicit dates cover only upstream odd weeks and multi-teacher week groups, without teacher fields', () => {
  const parsed = parseTimetable(payload(cell(), cell({ cellDetail: [{ text: '甲[3周] 乙[5周]' }] })), '2026-09-07')
  assert.deepEqual(parsed.weeksCovered, [1, 3, 5])
  assert.deepEqual(parsed.entries.map(row => row.start).sort(), ['2026-09-08T08:00:00+08:00', '2026-09-22T08:00:00+08:00', '2026-10-06T08:00:00+08:00'])
  assert.equal(parsed.entries[0].sourceKey, 'teaching:数学:2026-09-08:08:00')
  for (const row of parsed.entries) {
    assert.equal(row.category, 'course'); assert.equal(row.lock, true); assert.equal(row.location, 'A101')
    assert.equal('teacher' in row, false); assert.equal('classroom' in row, false); assert.equal('weekRange' in row, false)
  }
  const movedRoom = parseTimetable(payload(cell({ placeName: 'C303', endTime: '09:40' })), '2026-09-07')
  assert.equal(movedRoom.entries[0].sourceKey, parsed.entries[0].sourceKey)
})

test('reject invalid anchors, weekdays and incomplete times instead of inventing dates', () => {
  assert.throws(() => parseTimetable(payload(cell()), '2026-09-08'), /周一/)
  assert.throws(() => parseTimetable(payload(cell()), '2026-02-30'), /周一/)
  assert.equal(parseTimetable(payload(cell({ dayOfWeek: 1.5 })), '2026-09-07').entries.length, 0)
  assert.equal(parseTimetable(payload(cell({ endTime: '' })), '2026-09-07').entries.length, 0)
})

test('exam entries use China time, stable date identity, room and lock; missing end keeps only task', () => {
  const parsed = parseExams([exam(), exam({ examDate: '2026-12-01', endTime: '' }), exam({ examDate: '2026-02-30' })])
  assert.equal(parsed.entries.length, 1); assert.equal(parsed.tasks.length, 2)
  assert.deepEqual(parsed.entries[0], { sourceKey: 'exam:数学\u00002026-11-10', title: '数学 考试', description: '地点：B202；座位：12；结束：16:00', location: 'B202', start: '2026-11-10T14:00:00+08:00', end: '2026-11-10T16:00:00+08:00', category: 'exam', lock: true, allDay: false })
  assert.equal(parseExams([exam({ startTime: '15:00' })]).entries[0].sourceKey, parsed.entries[0].sourceKey)
})

test('one source snapshot contains teaching and exams; repeat keeps ids, changes room, removes cancellations', async () => {
  const h = harness()
  h.entries.set('user', { id: 'user', title: '私人安排', source: null, sourceKey: null })
  const first = await h.sync()
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].source, 'buaa')
  assert.deepEqual(first.entries, { created: 3, updated: 0, cleared: 0, total: 3 })
  const ids = [...h.entries.keys()]
  const again = await h.sync()
  assert.deepEqual(again.entries, { created: 0, updated: 0, cleared: 0, total: 3 })
  assert.deepEqual([...h.entries.keys()], ids)
  h.jw.fetchSchedule = async () => payload(cell({ placeName: 'D404', weeksAndTeachers: '1周' }))
  h.jw.fetchExams = async () => ({ datas: [] })
  const changed = await h.sync()
  assert.deepEqual(changed.entries, { created: 0, updated: 1, cleared: 2, total: 1 })
  assert.equal(h.tasks.size, 0); assert.ok(h.entries.has('user'))
  assert.equal(h.states.buaa.termCode.length > 0, true)
  assert.equal(JSON.stringify(h.states).includes('test-only'), false)
})

test('transient exam failure preserves exam entries and tasks while refreshing teaching', async () => {
  const h = harness(); await h.sync()
  const before = structuredClone([...h.entries.values()].filter(row => row.category === 'exam'))
  const taskBefore = structuredClone([...h.tasks.values()])
  h.jw.fetchExams = async () => { throw new Error('offline') }
  h.jw.fetchSchedule = async () => payload(cell({ placeName: 'E505' }))
  const result = await h.sync()
  assert.equal(result.exams.failed, 'offline')
  assert.deepEqual([...h.entries.values()].filter(row => row.category === 'exam'), before)
  assert.deepEqual([...h.tasks.values()], taskBefore)
  h.jw.fetchExams = async () => { throw Object.assign(new Error('login expired'), { code: 'auth' }) }
  const writes = h.calls.length
  await assert.rejects(h.sync(), /login expired/)
  assert.equal(h.calls.length, writes)
})

test('successful empty term clears source entries, not foreign exam tasks or history', async () => {
  const h = harness(); await h.sync()
  h.tasks.set('foreign', { id: 'foreign', source: 'manual', title: '别的考试', due: '2026-11-01T08:00:00+08:00', taskType: 'exam' })
  h.tasks.set('history', { id: 'history', source: 'buaa', title: '旧考试', due: '2026-01-01T08:00:00+08:00', taskType: 'exam' })
  h.jw.fetchSchedule = async () => payload(); h.jw.fetchExams = async () => ({ datas: [] })
  assert.equal((await h.sync()).entries.cleared, 3)
  assert.deepEqual([...h.tasks.keys()].sort(), ['foreign', 'history'])
})

test('both source adapters integrate with real core snapshot and generic entry APIs', async () => {
  const tables = new Map()
  let global = { termStart: '2026-09-07', sourceState: { buaa: { buaaId: '23370001' } } }
  const domain = {
    global: { get: () => global, set: async value => { global = value } },
    table(name) {
      if (!tables.has(name)) tables.set(name, new Map())
      const rows = tables.get(name)
      return { get: id => rows.get(id), entries: () => rows.entries(), put: async (id, row) => { rows.set(id, row) }, delete: async id => rows.delete(id) }
    },
  }
  const ctx = { logger: { warn() {}, info() {} } }
  const service = createScheduleService(ctx, domain)
  await service.setSourceState('buaa', { buaaId: '23370001' })
  const jw = { ssoLogin: async () => ({}), fetchSchedule: async () => payload(cell()), fetchExams: async () => ({ datas: [exam()] }) }
  const first = await runSync({ service, jw }, { password: 'test-only' })
  assert.equal(first.entries.total, 3)
  assert.equal(service.listTasks({ scope: 'all' }).length, 1)
  assert.ok(service.listEntries().every(row => row.source === 'buaa' && row.lock && row.location))
  const teachingId = service.listEntries().find(row => row.category === 'course').id
  assert.equal((await runSync({ service, jw }, { password: 'test-only' })).entries.created, 0)
  assert.ok(service.listEntries().some(row => row.id === teachingId))
  const importedIds = service.listEntries().map(row => row.id).sort()
  await service.setCategories(service.getMeta().categories.filter(category => !['course', 'exam'].includes(category.id)))
  assert.ok(service.listEntries().every(row => row.category === 'other'))
  const fetchExams = jw.fetchExams
  jw.fetchExams = async () => { throw new Error('offline after deleting exam category') }
  const failed = await runSync({ service, jw }, { password: 'test-only' })
  assert.equal(failed.exams.failed, 'offline after deleting exam category')
  assert.deepEqual(service.listEntries().map(row => row.id).sort(), importedIds)
  assert.ok(service.listEntries().every(row => row.category === 'other'))
  assert.ok(!service.getMeta().categories.some(category => ['course', 'exam'].includes(category.id)))
  jw.fetchExams = fetchExams
  await runSync({ service, jw }, { password: 'test-only' })
  assert.deepEqual(service.listEntries().map(row => row.id).sort(), importedIds)
  assert.ok(service.listEntries().every(row => row.category === 'other'))
  const prediction = () => ({
    version: '9.9',
    update: { utc: '2099-11-10T22:00:00Z', end_utc: '2099-11-11T03:00:00Z' },
    preview: { utc: '2099-10-30T11:00:00Z', end_utc: '2099-10-30T12:30:00Z' },
    update_confidence: 'official',
    preview_confidence: 'official',
  })
  let livePrediction = prediction()
  const calendarApi = {
    games: async () => [{ id: 'hsr', status: 'ok', prediction: livePrediction }],
    latestNotice: async () => null,
    putOverride: async (gameId, payload) => {
      const merged = structuredClone(livePrediction)
      if (payload.update_start) {
        merged.update = {
          utc: payload.update_start,
          end_utc: payload.update_end ?? merged.update.end_utc,
        }
      }
      if (payload.preview_start) {
        merged.preview = {
          utc: payload.preview_start,
          end_utc: payload.preview_end
            ?? new Date(Date.parse(payload.preview_start) + 90 * 60_000).toISOString(),
        }
      }
      if (payload.version) merged.version = payload.version
      livePrediction = merged
      return { data: { game: gameId } }
    },
    deleteOverride: async gameId => ({ data: { game: gameId, cleared: true } }),
  }
  const gacha = createGachaService(ctx, { service, calendarApi })
  try {
    await gacha.applyOfficial({ game: 'hsr', update_start: '2099-11-11T06:00:00+08:00', preview_start: '2099-10-30T19:00:00+08:00' })
    const preview = service.listEntries().find(row => row.source === 'gacha')
    assert.equal(preview.sourceKey, 'hsr:preview'); assert.equal(preview.lock, true)
    await service.updateEntry(preview.id, { title: '我的标题', location: '宿舍' })
    await gacha.applyOfficial({ game: 'hsr', preview_start: '2099-10-31T19:00:00+08:00' })
    const updated = service.listEntries().find(row => row.id === preview.id)
    assert.equal(updated.title, '我的标题'); assert.equal(updated.location, '宿舍')
    assert.equal(updated.start, '2099-10-31T19:00:00+08:00')
    jw.fetchSchedule = async () => payload(); jw.fetchExams = async () => ({ datas: [] })
    await runSync({ service, jw }, { password: 'test-only' })
    assert.deepEqual(service.listEntries().map(row => row.id), [preview.id])
    await gacha.setEnabled('hsr', false)
    assert.equal(service.listEntries().length, 0)
  } finally { gacha.dispose() }
})

test('matching manual exam task retains user fields while due is corrected', async () => {
  const h = harness()
  h.tasks.set('manual', { id: 'manual', title: '数学', due: '2026-11-10T13:00:00+08:00', description: '我的笔记', priority: 'low', source: null, taskType: 'exam' })
  await h.sync()
  assert.equal(h.tasks.size, 1)
  assert.equal(h.tasks.get('manual').due, '2026-11-10T14:00:00+08:00')
  assert.equal(h.tasks.get('manual').description, '我的笔记'); assert.equal(h.tasks.get('manual').priority, 'low')
})
