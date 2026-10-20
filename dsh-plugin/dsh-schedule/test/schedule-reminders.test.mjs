/**
 * Offline tests for the schedule-item reminder derivation (docs 00 §4.4,
 * docs 09 §2.1) — pure module, no host runtime needed (node --test).
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveScheduleReminders, ENTRY_WINDOW_MS } from '../host/schedule-reminders.js'

const NOW = Date.parse('2026-10-21T08:00:00+08:00')
const iso = offsetMin => new Date(NOW + offsetMin * 60_000).toISOString()

const derive = ({ occurrences = [], entries = [], classLeadMinutes = 10, examLeadMinutes = 1440, eventLeadMinutes = 15 } = {}) =>
  deriveScheduleReminders({ occurrences, entries, nowMs: NOW, classLeadMinutes, examLeadMinutes, eventLeadMinutes })

const classOcc = (overrides = {}) => ({
  courseId: 'c1', courseName: '高等数学', teacher: '张三', classroom: '教三-201',
  day: '2026-10-21', start: iso(120), end: iso(180), baseDay: '2026-10-21',
  overridden: false, canceled: false,
  ...overrides,
})

test('a future class derives a reminder at start minus the class lead', () => {
  const out = derive({ occurrences: [classOcc()] })
  assert.equal(out.length, 1)
  assert.deepEqual(
    { kind: out[0].kind, key: out[0].key, title: out[0].title, classroom: out[0].classroom },
    { kind: 'class', key: 'class-c1@2026-10-21', title: '高等数学', classroom: '教三-201' },
  )
  assert.equal(Date.parse(out[0].at), Date.parse(iso(120)) - 10 * 60_000)
})

test('the reminder key carries the date: the same course tomorrow is a separate reminder', () => {
  const out = derive({
    occurrences: [
      classOcc(),
      classOcc({ courseId: 'c1', baseDay: '2026-10-22', day: '2026-10-22', start: iso(120 + 1440), end: iso(180 + 1440) }),
    ],
  })
  assert.deepEqual(out.map(r => r.key), ['class-c1@2026-10-21', 'class-c1@2026-10-22'])
})

test('canceled occurrences (停课) stay silent', () => {
  const out = derive({ occurrences: [classOcc({ canceled: true })] })
  assert.equal(out.length, 0)
})

test('a class whose lead window already passed is dropped, not delivered late', () => {
  const out = derive({ occurrences: [classOcc({ start: iso(5) })] }) // 5min away, lead 10
  assert.equal(out.length, 0)
})

test('exam entries ride the exam lead, other entries the event lead', () => {
  const out = derive({
    entries: [
      { id: 'e1', title: '离散数学考试', category: 'exam', start: iso(2 * 1440), end: iso(2 * 1440 + 120) },
      { id: 'e2', title: '班会', category: 'meeting', start: iso(60), end: iso(90) },
    ],
  })
  assert.deepEqual(out.map(r => r.key), ['entry-e2', 'entry-e1']) // sorted by at
  assert.equal(Date.parse(out[0].at), Date.parse(iso(60)) - 15 * 60_000)
  assert.equal(Date.parse(out[1].at), Date.parse(iso(2 * 1440)) - 1440 * 60_000)
})

test('allDay flag rides and the derivation tolerates a malformed start', () => {
  const out = derive({
    entries: [
      { id: 'e1', title: '运动会', category: 'other', start: iso(1440), end: iso(1440 + 600), allDay: true },
      { id: 'e2', title: '坏数据', category: 'other', start: 'not-a-date', end: iso(100) },
    ],
  })
  assert.equal(out.length, 1)
  assert.equal(out[0].allDay, true)
  assert.equal(out[0].key, 'entry-e1')
})

test('entries already inside their lead window are dropped; the horizon covers the exam lead', () => {
  // an exam 9 days out: its reminder moment (start − 24h) is 8 days out —
  // beyond NOW the caller's 8-day listEntries window can't see it YET, but
  // once the window reaches it the moment is still in the future (never
  // silently dropped by this module).
  const out = derive({
    entries: [
      { id: 'e1', title: '太早的考试', category: 'exam', start: iso(9 * 1440), end: iso(9 * 1440 + 120) },
      { id: 'e2', title: '马上开始的会议', category: 'meeting', start: iso(10), end: iso(20) },
    ],
  })
  assert.deepEqual(out.map(r => r.key), ['entry-e1']) // 8d-out reminder moment still future
  assert.ok(ENTRY_WINDOW_MS >= 1440 * 60_000 + 24 * 60 * 60 * 1000 - 60_000)
})
