/**
 * Schedule-item reminder derivation (pure, zero-dep — `node --test
 * test/schedule-reminders.test.mjs` pins it without any host runtime).
 *
 * The reminder subsystem's derived set `service.upcomingReminders()` used
 * to cover TASK deadlines only, so recurring classes (weekly course rules)
 * and calendar entries — the 教务 import lands exams and meetings HERE,
 * not as tasks — had no reminder surface at all: the exact「有课有考试但
 * 忘了去」gap. Timing policy lives here and nowhere else (docs 00 §4.4):
 * this module applies the lead minutes; the bridge just posts whatever
 * comes out into the pet notice queue (contract §4b). These items are
 * deliberately NOT mirrored into ctx.schedule — a class meets several
 * times a week and one agent prompt per meeting is spam; the pet bubble
 * is the right weight (docs 09 §2.1).
 *
 * Item shape (superset of the task reminder's):
 *   { kind: 'class' | 'entry', key, title, at, start, ... }
 * `key` is deterministic and date-scoped wherever the source repeats
 * (`class-<courseId>@<baseDay>` — the 去重键要含日期 rule), so bridge-side
 * notice dedup needs no memory of its own.
 */

/** Entries scan horizon: ≥ the largest lead (exam default 1d) so a far
 * exam's reminder moment never falls outside the window before firing. */
export const ENTRY_WINDOW_MS = 8 * 24 * 60 * 60 * 1000

const leadMinutesForEntry = (category, examLeadMinutes, eventLeadMinutes) =>
  category === 'exam' ? examLeadMinutes : eventLeadMinutes

/**
 * Project occurrences + entries into future reminder moments.
 * @param {object} input
 * @param {readonly object[]} input.occurrences - `service.weekOccurrences(today)`
 *   rows (`{ courseId, courseName, classroom, teacher, start, baseDay, canceled }`).
 * @param {readonly object[]} input.entries - `service.listEntries(now, now+8d)` rows.
 * @param {number} input.nowMs
 * @param {number} input.classLeadMinutes
 * @param {number} input.examLeadMinutes
 * @param {number} input.eventLeadMinutes
 * @returns {object[]} reminder items sorted by `at`; past moments and
 *   canceled/unparseable rows are dropped.
 */
export function deriveScheduleReminders({
  occurrences, entries, nowMs, classLeadMinutes, examLeadMinutes, eventLeadMinutes,
}) {
  const out = []
  for (const occ of occurrences) {
    if (occ.canceled === true) continue // 停课的课不再提醒
    const startMs = Date.parse(occ.start)
    if (!Number.isFinite(startMs)) continue
    const atMs = startMs - classLeadMinutes * 60_000
    if (!(atMs > nowMs)) continue
    out.push({
      kind: 'class',
      key: `class-${occ.courseId}@${occ.baseDay}`,
      title: occ.courseName,
      at: new Date(atMs).toISOString(),
      start: occ.start,
      classroom: occ.classroom,
      teacher: occ.teacher,
    })
  }
  for (const entry of entries) {
    const startMs = Date.parse(entry.start)
    if (!Number.isFinite(startMs)) continue
    const lead = leadMinutesForEntry(entry.category, examLeadMinutes, eventLeadMinutes)
    const atMs = startMs - lead * 60_000
    if (!(atMs > nowMs)) continue
    out.push({
      kind: 'entry',
      key: `entry-${entry.id}`,
      title: entry.title,
      category: entry.category,
      at: new Date(atMs).toISOString(),
      start: entry.start,
      allDay: entry.allDay === true,
    })
  }
  return out.sort((a, b) => a.at.localeCompare(b.at))
}
