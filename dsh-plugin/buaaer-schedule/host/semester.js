/**
 * Teaching-semester calendar math: week-range grammar, term-week derivation,
 * and occurrence projection from weekly course rules.
 *
 * All calendar dates are `YYYY-MM-DD` strings in the host's local zone; all
 * projected instants are emitted as ISO 8601 with the host's local offset so
 * the stored value states its own zone.
 */

const DAY_MS = 86_400_000

/** Parse a `YYYY-MM-DD` string into a local-noon Date (noon avoids DST edges). */
export function parseDate(date) {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d, 12, 0, 0, 0)
}

/** Local calendar key of a Date, `YYYY-MM-DD`. */
export function dateKey(date) {
  const p = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

/** ISO 8601 with explicit local offset for a local wall-clock datetime. */
export function zonedIso(y, m, d, hh, mm) {
  const date = new Date(y, m - 1, d, hh, mm, 0, 0)
  const off = -date.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  const p = n => String(n).padStart(2, '0')
  const zone = `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
  return `${dateKey(date)}T${p(hh)}:${p(mm)}:00${zone}`
}

/** Monday of the week containing `date` (`YYYY-MM-DD`). */
export function mondayOf(date) {
  const d = parseDate(date)
  const shift = (d.getDay() + 6) % 7
  d.setDate(d.getDate() - shift)
  return dateKey(d)
}

/** Add `days` to a `YYYY-MM-DD` key. */
export function addDays(date, days) {
  const d = parseDate(date)
  d.setDate(d.getDate() + days)
  return dateKey(d)
}

/**
 * Expand a week-range expression into the set of teaching weeks it covers.
 * @returns {Set<number>} week numbers, 1-based; empty set when malformed.
 */
export function parseWeekRange(weekRange) {
  const weeks = new Set()
  for (const part of String(weekRange).split(',')) {
    const range = part.match(/^(\d{1,2})(?:-(\d{1,2}))?$/)
    if (!range) continue
    const from = Number(range[1])
    const to = range[2] === undefined ? from : Number(range[2])
    for (let w = from; w <= to; w++) {
      if (w >= 1 && w <= 60) weeks.add(w)
    }
  }
  return weeks
}

/**
 * Teaching week number of `date`, or null when `termStart` is unset or the
 * date falls before the term. Week N spans [termStart + 7(N-1), +7N).
 */
export function termWeek(termStart, date) {
  if (!termStart) return null
  const start = parseDate(mondayOf(termStart)).getTime()
  const today = parseDate(mondayOf(date)).getTime()
  const week = Math.floor((today - start) / (7 * DAY_MS)) + 1
  return week >= 1 ? week : null
}

/** Calendar date of `dayOfWeek` (1-7) in teaching `week`, or null if unset. */
export function dateOfWeek(termStart, week, dayOfWeek) {
  if (!termStart) return null
  return addDays(mondayOf(termStart), (week - 1) * 7 + (dayOfWeek - 1))
}

/**
 * Project weekly course rules onto concrete occurrences for one week.
 * @param {readonly object[]} courses - rows from the `courses` table.
 * @param {string} weekStart - Monday of the displayed week, `YYYY-MM-DD`.
 * @param {string|null} termStart - term anchor; required for projection.
 * @returns {object[]} occurrences `{ courseId, courseName, classroom, day,
 *   start, end }` with ISO datetimes; empty when the anchor is missing.
 */
export function deriveWeekOccurrences(courses, weekStart, termStart) {
  if (!termStart) return []
  const week = termWeek(termStart, weekStart)
  if (week === null) return []
  const occurrences = []
  for (const course of courses) {
    if (!parseWeekRange(course.weekRange).has(week)) continue
    const day = addDays(mondayOf(weekStart), course.dayOfWeek - 1)
    const [y, m, d] = day.split('-').map(Number)
    occurrences.push({
      courseId: course.id,
      courseName: course.courseName,
      classroom: course.classroom,
      day,
      start: zonedIso(y, m, d, ...hhmmParts(course.startTime)),
      end: zonedIso(y, m, d, ...hhmmParts(course.endTime)),
    })
  }
  return occurrences
}

function hhmmParts(hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  return [h, m]
}

/**
 * BUAA term code for a date, mirroring the school's rule: Aug-Dec is the
 * first term of `{Y}-{Y+1}`, Jan-Feb the first term of `{Y-1}-{Y}`, the
 * rest the second term of `{Y}-{Y+1}`.
 */
export function termCodeFor(date) {
  const d = parseDate(date)
  const y = d.getFullYear()
  if (d.getMonth() + 1 >= 8) return `${y}-${y + 1}-1`
  if (d.getMonth() + 1 <= 2) return `${y - 1}-${y}-1`
  return `${y}-${y + 1}-2`
}

/** Today's local date key. */
export function today() {
  return dateKey(new Date())
}
