import assert from 'node:assert/strict'
import test from 'node:test'
import { materializeEntries } from '../host/migrate.js'

const rule = { id: 'a', courseName: '数学', classroom: '101', dayOfWeek: 1, weekRange: '1', startTime: '08:00', endTime: '09:00', updatedAt: '2026-10-21T00:00:00Z' }

test('migration preserves moved exceptions whose base no longer projects or whose rule is missing', () => {
  const exceptions = [
    { courseId: 'a', baseDay: '2026-09-14', courseName: '补课', classroom: '102', start: '2026-10-01T10:00:00+08:00', end: '2026-10-01T11:00:00+08:00', updatedAt: rule.updatedAt },
    { courseId: 'missing', baseDay: '2026-09-21', courseName: '外部调课', classroom: '103', start: '2026-10-02T10:00:00+08:00', end: '2026-10-02T11:00:00+08:00', updatedAt: rule.updatedAt },
  ]
  const rows = materializeEntries([rule], exceptions, '2026-09-07')
  assert.equal(rows.length, 3)
  assert.ok(rows.some(row => row.title === '补课' && row.start === exceptions[0].start))
  assert.ok(rows.some(row => row.title === '外部调课' && row.location === '103'))
})

test('migration rejects invalid dates and non-Monday anchors without guessing', () => {
  for (const termStart of ['', '2026-02-30', '2026-09-09']) {
    assert.throws(() => materializeEntries([rule], [], termStart), /第一周周一/)
  }
})

test('overlapping weekly groups materialize once per semantic source identity', () => {
  const rows = materializeEntries([{ ...rule, weekRange: '1-3' }, { ...rule, id: 'b', weekRange: '3-5' }], [], '2026-09-07')
  assert.equal(rows.length, 5)
  assert.equal(new Set(rows.map(row => row.sourceKey)).size, 5)
})
