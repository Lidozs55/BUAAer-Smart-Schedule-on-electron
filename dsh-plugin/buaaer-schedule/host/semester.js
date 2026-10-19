/**
 * Teaching-semester calendar math: week-range grammar, term-week derivation,
 * and occurrence projection from weekly course rules.
 *
 * All calendar dates are `YYYY-MM-DD` strings in the host's local zone; all
 * projected instants are emitted as ISO 8601 with the host's local offset so
 * the stored value states its own zone.
 */

const DAY_MS = 86_400_000

const pad2 = n => String(n).padStart(2, '0')

/** Parse a `YYYY-MM-DD` string into a local-noon Date (noon avoids DST edges). */
export function parseDate(date) {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d, 12, 0, 0, 0)
}

/** Local calendar key of a Date, `YYYY-MM-DD`. */
export function dateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** ISO 8601 with explicit local offset for a local wall-clock datetime. */
export function zonedIso(y, m, d, hh, mm) {
  const date = new Date(y, m - 1, d, hh, mm, 0, 0)
  const off = -date.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  const zone = `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  return `${dateKey(date)}T${pad2(hh)}:${pad2(mm)}:00${zone}`
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

/** Weekday of a `YYYY-MM-DD` key: 1 (Mon) … 7 (Sun). */
export function dayOfWeek(date) {
  return (parseDate(date).getDay() + 6) % 7 + 1
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

/** Local calendar day of a zoned ISO instant, `YYYY-MM-DD`. */
const isoDay = iso => dateKey(new Date(iso))

/**
 * Project weekly course rules onto the 7 display days of a window
 * (docs/10 P8). Each day derives its own teaching week and weekday, so a
 * window may straddle two teaching weeks and may start on any weekday —
 * the caller passes the window's ANCHOR day (today), not a Monday.
 *
 * `overrides` are per-occurrence manual exceptions (holiday make-up,
 * moved class, cancellation). An override is matched by `courseId@baseDay`
 * and replaces that projection; overrides moved INTO this window from a
 * base day outside it are appended too, so a class can be pushed across
 * week boundaries. Canceled overrides are still emitted (flagged) so the
 * client can render a faint block the user can click to restore.
 *
 * @param {readonly object[]} courses - rows from the `courses` table.
 * @param {string} windowStart - anchor day of the displayed 7-day window.
 * @param {string|null} termStart - term anchor; required for projection.
 * @param {readonly object[]} [overrides] - rows from `course_overrides`.
 * @returns {object[]} occurrences `{ courseId, courseName, teacher,
 *   classroom, day, start, end, baseDay, overridden, canceled, overrideId? }`;
 *   empty when the anchor is missing.
 */
export function deriveWeekOccurrences(courses, windowStart, termStart, overrides = []) {
  if (!termStart) return []
  const days = Array.from({ length: 7 }, (_, i) => addDays(windowStart, i))
  const daySet = new Set(days)
  const overrideByKey = new Map(
    overrides.map(row => [`${row.courseId}@${row.baseDay}`, row]))
  const emitted = new Set()
  const occurrences = []

  const emitOverride = override => {
    if (emitted.has(override.id)) return
    emitted.add(override.id)
    const day = isoDay(override.start)
    if (!daySet.has(day)) return // moved out of the displayed window
    occurrences.push({
      courseId: override.courseId,
      courseName: override.courseName,
      teacher: override.teacher,
      classroom: override.classroom,
      day,
      start: override.start,
      end: override.end,
      baseDay: override.baseDay,
      overridden: true,
      canceled: override.canceled === true,
      overrideId: override.id,
    })
  }

  for (const day of days) {
    const week = termWeek(termStart, day)
    if (week === null) continue
    const weekday = dayOfWeek(day)
    for (const course of courses) {
      if (course.dayOfWeek !== weekday) continue
      if (!parseWeekRange(course.weekRange).has(week)) continue
      const override = overrideByKey.get(`${course.id}@${day}`)
      if (override !== undefined) {
        emitOverride(override)
        continue
      }
      const [y, m, d] = day.split('-').map(Number)
      occurrences.push({
        courseId: course.id,
        courseName: course.courseName,
        teacher: course.teacher,
        classroom: course.classroom,
        day,
        start: zonedIso(y, m, d, ...hhmmParts(course.startTime)),
        end: zonedIso(y, m, d, ...hhmmParts(course.endTime)),
        baseDay: day,
        overridden: false,
        canceled: false,
      })
    }
  }

  // Classes moved into this window from a base day outside it: the base
  // loop above never visits that rule day, so append them by target day.
  for (const override of overrides) emitOverride(override)

  return occurrences.sort((a, b) => a.start.localeCompare(b.start))
}

function hhmmParts(hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  return [h, m]
}

/**
 * Today's local date key.
 */
export function today() {
  return dateKey(new Date())
}

/**
 * Display-day anchor for "today" (docs/10 P8): before 04:00 local time the
 * current moments still belong to yesterday's grid day, so the default
 * window starts yesterday. Mirrors the client's gridmath.anchorToday.
 */
export function anchorToday() {
  const now = new Date()
  if (now.getHours() >= 4) return dateKey(now)
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  return dateKey(yesterday)
}
