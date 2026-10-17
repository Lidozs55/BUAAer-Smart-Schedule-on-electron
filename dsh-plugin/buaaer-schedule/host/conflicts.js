/**
 * Lightweight overlap detection for schedule writes (decision D-6).
 *
 * Every persisted datetime carries an explicit UTC offset, so overlap is
 * plain instant-interval intersection: blocks collide when
 * `startA < endB && startB < endA`. Whole-day blocks span
 * `[day T00:00, day+1 T00:00)` (a convention the service normalizes to).
 * Course occurrences count as occupied time so a write can surface "this
 * collides with a class" as an actionable reason.
 */
import { deriveWeekOccurrences, mondayOf } from './semester.js'

const instant = value => {
  const time = new Date(value).getTime()
  if (Number.isNaN(time)) throw new Error(`invalid datetime: ${value}`)
  return time
}

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd

/** Monday of the local week an ISO datetime falls in, `YYYY-MM-DD`. */
function mondayOfWeekOf(isoDatetime) {
  const date = new Date(isoDatetime)
  const shift = (date.getDay() + 6) % 7
  date.setDate(date.getDate() - shift)
  const p = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

/**
 * Find conflicts for one candidate against existing entries and the course
 * occurrences of the affected week.
 *
 * @param {object} candidate - `{ start, end, id? }`; `id` excludes the row
 *   itself when editing in place.
 * @param {object} context - `{ entries, courseRows, termStart }`.
 * @returns {object[]} conflicts with actionable, human-readable reasons.
 */
export function findConflicts(candidate, { entries, courseRows, termStart }) {
  const conflicts = []
  const candStart = instant(candidate.start)
  const candEnd = instant(candidate.end)

  for (const entry of entries) {
    if (entry.id === candidate.id) continue
    if (overlaps(candStart, candEnd, instant(entry.start), instant(entry.end))) {
      conflicts.push({
        with: 'entry',
        title: entry.title,
        time: `${entry.start} – ${entry.end}`,
        reason: `与既有条目「${entry.title}」时间重叠（${entry.start} – ${entry.end}）`,
      })
    }
  }

  if (!termStart) return conflicts
  const occurrences = deriveWeekOccurrences(courseRows, mondayOfWeekOf(candidate.start), termStart)
  for (const occurrence of occurrences) {
    if (overlaps(candStart, candEnd, instant(occurrence.start), instant(occurrence.end))) {
      const classroom = occurrence.classroom ? `，${occurrence.classroom}` : ''
      conflicts.push({
        with: 'course',
        title: occurrence.courseName,
        time: `${occurrence.start} – ${occurrence.end}`,
        reason: `与课程「${occurrence.courseName}」重叠（${occurrence.day} ${occurrence.start.slice(11, 16)} 起${classroom}）`,
      })
    }
  }
  return conflicts
}
