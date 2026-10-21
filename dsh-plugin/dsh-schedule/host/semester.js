/**
 * Calendar date math and teaching-week labels.
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
