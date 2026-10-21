import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveScheduleReminders, ENTRY_WINDOW_MS } from '../host/schedule-reminders.js'
import { attachReminders } from '../host/reminders.js'

const NOW = Date.parse('2026-10-21T08:00:00+08:00')
const iso = offset => new Date(NOW + offset * 60_000).toISOString()
const derive = entries => deriveScheduleReminders({ entries, nowMs: NOW, examLeadMinutes: 1440, eventLeadMinutes: 15 })
const entry = (extra = {}) => ({ id: 'one', title: '数学', category: 'study', location: '教三 201', start: iso(120), end: iso(180), lock: true, ...extra })

test('all entries use generic reminders with location, independent of lock', () => {
  const [out] = derive([entry()])
  assert.equal(out.kind, 'entry')
  assert.equal(out.key, 'entry-one')
  assert.equal(out.location, '教三 201')
  assert.equal(Date.parse(out.at), Date.parse(iso(120)) - 15 * 60_000)
  assert.deepEqual(derive([entry({ lock: false })]), [out])
})

test('separate dated entries have separate reminder identities', () => {
  const out = derive([entry(), entry({ id: 'two', start: iso(1560), end: iso(1620) })])
  assert.deepEqual(out.map(row => row.key), ['entry-one', 'entry-two'])
})

test('exam entries use exam lead and results are sorted by reminder time', () => {
  const out = derive([entry({ id: 'exam', category: 'exam', start: iso(2880) }), entry({ id: 'meeting', category: 'meeting', start: iso(60) })])
  assert.deepEqual(out.map(row => row.key), ['entry-meeting', 'entry-exam'])
  assert.equal(Date.parse(out[1].at), Date.parse(iso(2880)) - 1440 * 60_000)
})

test('all-day entries preserve their flag and malformed starts stay silent', () => {
  const out = derive([entry({ allDay: true, start: iso(1440) }), entry({ start: 'invalid' })])
  assert.equal(out.length, 1)
  assert.equal(out[0].allDay, true)
})

test('past reminder windows stay silent and scan horizon covers exam lead', () => {
  assert.deepEqual(derive([entry({ start: iso(10) })]), [])
  assert.ok(ENTRY_WINDOW_MS >= 2 * 1440 * 60_000)
})

test('entry remindLead overrides both tier defaults, null falls back', () => {
  const [out] = derive([entry({ remindLead: 120, start: iso(300), end: iso(360) })])
  assert.equal(Date.parse(out.at), Date.parse(iso(300)) - 120 * 60_000)
  const [exam] = derive([entry({ category: 'exam', remindLead: 0, start: iso(2880) })])
  assert.equal(Date.parse(exam.at), Date.parse(iso(2880)))
  const [fallback] = derive([entry({ remindLead: null, start: iso(300), end: iso(360) })])
  assert.equal(Date.parse(fallback.at), Date.parse(iso(300)) - 15 * 60_000)
})

test('task remindLead overrides the config tier while unset rows keep it', () => {
  const service = {
    listTasks: () => [
      { id: 't1', title: '作业', taskType: 'homework', due: iso(2880), remindLead: 120 },
      { id: 't2', title: '考试', taskType: 'exam', due: iso(2880) },
    ],
    listEntries: () => [],
    upcomingReminders: () => [],
  }
  attachReminders({ logger: { info() {} } }, service, {
    remindersEnabled: true, homeworkLeadMinutes: 30, examLeadMinutes: 1440,
    otherLeadMinutes: 30, eventLeadMinutes: 15,
  })
  const rows = service.upcomingReminders()
  assert.equal(Date.parse(rows.find(row => row.key === 't1').at), Date.parse(iso(2880)) - 120 * 60_000)
  assert.equal(Date.parse(rows.find(row => row.key === 't2').at), Date.parse(iso(2880)) - 1440 * 60_000)
})
