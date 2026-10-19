/**
 * Bundle-local calendar helpers. A source adapter must not import another
 * bundle's internals: the schedule core's public seam is the injected
 * `buaaerSchedule` service, not its time module.
 */

const DAY_MS = 86_400_000
const pad2 = n => String(n).padStart(2, '0')

/** Parse a `YYYY-MM-DD` string into a local-noon Date (noon avoids DST edges). */
const parseDate = date => {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d, 12, 0, 0, 0)
}

export const dateKey = date =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`

export const addDays = (date, days) => {
  const d = parseDate(date)
  d.setDate(d.getDate() + days)
  return dateKey(d)
}

/** Weekday of a `YYYY-MM-DD` key: 1 (Mon) … 7 (Sun). */
export const dayOfWeek = date => (parseDate(date).getDay() + 6) % 7 + 1

export const today = () => dateKey(new Date())

/** ISO 8601 with explicit local offset for a local wall-clock datetime. */
export function zonedIso(y, m, d, hh, mm) {
  const date = new Date(y, m - 1, d, hh, mm, 0, 0)
  const off = -date.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  const zone = `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  return `${dateKey(date)}T${pad2(hh)}:${pad2(mm)}:00${zone}`
}

/**
 * BUAA term code for a date: Aug–Dec is the first term of `{Y}-{Y+1}`,
 * Jan–Feb the first term of `{Y-1}-{Y}`, the rest the second term of
 * `{Y}-{Y+1}`.
 */
export function termCodeFor(date) {
  const d = parseDate(date)
  const y = d.getFullYear()
  if (d.getMonth() + 1 >= 8) return `${y}-${y + 1}-1`
  if (d.getMonth() + 1 <= 2) return `${y - 1}-${y}-1`
  return `${y}-${y + 1}-2`
}
