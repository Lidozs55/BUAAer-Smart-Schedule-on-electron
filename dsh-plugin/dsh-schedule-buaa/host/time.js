/**
 * Bundle-local calendar helpers. A source adapter must not import another
 * bundle's internals: the schedule core's public seam is the injected
 * `scheduleCore` service, not its time module. The core already knows the
 * teaching week of any date; this file only needs the term code.
 */

/** Parse a `YYYY-MM-DD` string into a local-noon Date (noon avoids DST edges). */
const parseDate = date => {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d, 12, 0, 0, 0)
}

/**
 * BUAA term code of the semester that BEGINS on `termStart` (the Monday of
 * week 1), e.g. `2026-09-07` → `2026-2027-1`. Derived from the anchor rather
 * than from today's date, so importing during a holiday still resolves to
 * the term the user is configuring.
 *
 * The academic year opens with the autumn term; `-3` is the summer term,
 * which BUAA runs through July and early August:
 *   9 月 – 次年 2 月 → 秋季学期    {Y}-{Y+1}-1
 *   3 月 – 6 月       → 春季学期    {Y-1}-{Y}-2
 *   7 月 – 8 月上旬   → 暑期学期    {Y-1}-{Y}-3
 *   8 月下旬          → 下一学年秋季 {Y}-{Y+1}-1（开学周落在 8 月的情况）
 */
export function termCodeFor(termStart) {
  const d = parseDate(termStart)
  const y = d.getFullYear()
  const month = d.getMonth() + 1
  if (month >= 9) return `${y}-${y + 1}-1`
  if (month <= 2) return `${y - 1}-${y}-1`
  if (month <= 6) return `${y - 1}-${y}-2`
  if (month === 7 || d.getDate() <= 20) return `${y - 1}-${y}-3`
  return `${y}-${y + 1}-1`
}

/** Human label for a term code, e.g. `2026-2027-1` → `2026-2027 学年 第 1 学期`. */
export const termLabel = termCode =>
  /^(\d{4})-(\d{4})-(\d)$/.test(termCode ?? '')
    ? `${termCode.slice(0, 9)} 学年 第 ${termCode.slice(-1)} 学期`
    : termCode