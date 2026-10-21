/**
 * Parsers for the whole-term JW endpoints.
 *
 * `getMyScheduleDetail.do?type=term` answers with `datas.arrangedList`: one
 * entry per weekly cell, already carrying `dayOfWeek`, `beginTime`,
 * `endTime`, `placeName` and — unlike the day-by-day `detail.do` feed — the
 * complete week information. So no term anchor is needed to DEDUCE weeks;
 * the adapter projects only those weeks onto explicit calendar dates.
 *
 * Only what a calendar block actually shows is kept: course name, weekday,
 * start/end time, room and weeks. Teacher names, credits, course codes,
 * teaching targets, colours and the school's display strings are dropped
 * here rather than stored — the schedule has no use for them.
 *
 * Week data arrives in three shapes and all of them are used, in this order:
 *   1. `cellDetail` week lines, `教师[3-12周]` — the text the JW grid prints
 *      inside the cell, and the only place ALL week groups of a cell survive
 *      (a cell may hold several, e.g. `潘星[10周] 黄宁[12周]`).
 *   2. `weeksAndTeachers`, `1-4周,6-16周[理论]/乔雷[主讲]` — the summary
 *      field. Reliable, but it only lists the FIRST week group of a cell.
 *   3. nothing usable → the cell is skipped.
 */

/** Weeks beyond this are certainly a parse artefact, not a timetable. */
const MAX_WEEK = 60

const WEEK_TOKEN_RE = /(\d{1,2})(?:\s*-\s*(\d{1,2}))?\s*周\s*(?:[(（]\s*([单双])\s*[)）])?/g
/** `教师[3-12周]` — one cell may print several of these. */
const TEACHER_WEEK_RE = /[^\s[\]()（）]+\[[^[\]]*周[^[\]]*\]/g
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * Normalize a JW week spec (`1-4周,6-16周`, `2-8周(双)`, `9周`) into the
 * core's grammar (`1-4,6-16`). Odd/even ranges are expanded into the exact
 * weeks they cover, because `N-M` alone would wrongly admit the other half.
 * @returns {string|null} null when no week could be read.
 */
export function normalizeWeeks(spec) {
  const weeks = new Set()
  for (const match of String(spec).matchAll(WEEK_TOKEN_RE)) {
    const from = Number(match[1])
    const to = match[2] === undefined ? from : Number(match[2])
    const parity = match[3]
    for (let w = from; w <= to; w += 1) {
      if (w < 1 || w > MAX_WEEK) continue
      if (parity === '单' && w % 2 === 0) continue
      if (parity === '双' && w % 2 !== 0) continue
      weeks.add(w)
    }
  }
  return weeks.size === 0 ? null : formatWeeks([...weeks].sort((a, b) => a - b))
}

/** Compress ascending week numbers back into `1-4,6-16` runs. */
function formatWeeks(sorted) {
  const runs = []
  let start = sorted[0]
  let previous = start
  for (const week of sorted.slice(1)) {
    if (week === previous + 1) {
      previous = week
      continue
    }
    runs.push(start === previous ? `${start}` : `${start}-${previous}`)
    start = week
    previous = week
  }
  runs.push(start === previous ? `${start}` : `${start}-${previous}`)
  return runs.join(',')
}

/**
 * Week ranges of one timetable cell, one per teacher/activity group the
 * school printed. Groups that share a range collapse into it.
 * @returns {string[]} possibly empty.
 */
function weekRangesOf(item) {
  const ranges = new Set()
  for (const cell of Array.isArray(item.cellDetail) ? item.cellDetail : []) {
    const text = typeof cell?.text === 'string' ? cell.text : ''
    for (const token of text.match(TEACHER_WEEK_RE) ?? []) {
      const range = normalizeWeeks(token.slice(token.indexOf('[') + 1, -1))
      if (range !== null) ranges.add(range)
    }
  }
  if (ranges.size === 0) {
    // Fall back to the summary field, whose weeks precede the first `[`.
    const raw = typeof item.weeksAndTeachers === 'string' ? item.weeksAndTeachers : ''
    const bracket = raw.indexOf('[')
    const range = normalizeWeeks(bracket === -1 ? raw : raw.slice(0, bracket))
    if (range !== null) ranges.add(range)
  }
  return [...ranges]
}

/** Rule identity: the same weekly slot, whatever the room says. */
const ruleKey = rule =>
  [rule.courseName, rule.dayOfWeek, rule.startTime, rule.weekRange].join('\u0000')

/**
 * Turn one timetable cell into weekly course rules (one per week group).
 * Cells without a weekday or a usable time belong to the school's "not
 * arranged yet" list, not to the grid.
 */
function rulesOfItem(item) {
  if (item === null || typeof item !== 'object') return []
  const courseName = String(item.courseName ?? '').trim()
  const dayOfWeek = Number(item.dayOfWeek)
  const startTime = String(item.beginTime ?? '')
  const endTime = String(item.endTime ?? '')
  if (courseName === '' || !Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7) return []
  if (!HHMM_RE.test(startTime) || !HHMM_RE.test(endTime)) return []
  if (endTime <= startTime) return []
  const location = String(item.placeName ?? '').trim()
  return weekRangesOf(item).map(weekRange => ({
    courseName,
    location,
    dayOfWeek,
    weekRange,
    startTime,
    endTime,
  }))
}

/**
 * Parse a `getMyScheduleDetail.do` payload into course rules.
 * The same slot reported by several cells becomes one rule.
 * @param {object} payload - the raw `{ datas, code, msg }` envelope.
 * @returns {object[]} internal upstream timetable rules.
 */
function parseCourses(payload) {
  const datas = payload?.datas
  const rules = new Map()
  for (const list of [datas?.arrangedList, datas?.practiceList]) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      for (const rule of rulesOfItem(item)) {
        const key = ruleKey(rule)
        const prior = rules.get(key)
        // Same slot in two lists: keep the one that knows its room.
        if (prior === undefined || (prior.location === '' && rule.location !== '')) {
          rules.set(key, rule)
        }
      }
    }
  }
  return [...rules.values()]
}

/** Project only the school's explicit weeks onto China-local calendar dates. */
export function parseTimetable(payload, termStart) {
  const anchor = new Date(`${termStart}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(termStart)
    || !Number.isFinite(anchor.getTime())
    || anchor.toISOString().slice(0, 10) !== termStart || anchor.getUTCDay() !== 1) {
    throw new Error('学期起始日期必须是有效的第一周周一（YYYY-MM-DD）')
  }
  const entries = new Map()
  const weeksCovered = new Set()
  for (const rule of parseCourses(payload)) {
    for (const part of rule.weekRange.split(',')) {
      const [from, to = from] = part.split('-').map(Number)
      for (let week = from; week <= to; week += 1) {
        weeksCovered.add(week)
        const date = new Date(anchor.getTime() + ((week - 1) * 7 + rule.dayOfWeek - 1) * 86_400_000)
          .toISOString().slice(0, 10)
        const sourceKey = `teaching:${rule.courseName}:${date}:${rule.startTime}`
        const entry = {
          sourceKey, title: rule.courseName, description: null, location: rule.location || null,
          start: `${date}T${rule.startTime}:00+08:00`, end: `${date}T${rule.endTime}:00+08:00`,
          category: 'study', lock: true, allDay: false,
        }
        const prior = entries.get(sourceKey)
        if (prior === undefined || (!prior.location && entry.location)) entries.set(sourceKey, entry)
      }
    }
  }
  return { entries: [...entries.values()], weeksCovered: [...weeksCovered].sort((a, b) => a - b) }
}

/** Student number the endpoint echoes back, when the payload carries one. */
export function studentIdOf(payload) {
  const code = payload?.datas?.code
  return typeof code === 'string' && /^\d{6,}$/.test(code.trim()) ? code.trim() : ''
}

/**
 * Parse `exams.do` into exam task drafts and explicitly timed calendar entries.
 *
 * The endpoint is a whole-term list too, and one course can sit TWO exams in
 * a term (a mid-term and a final: `工科数学分析（1）` shows up in week 10 and
 * week 18), so a course name is not an identity. The date is: `key` below is
 * what the sync reconciles on.
 *
 * Only what a deadline needs is kept — course, start instant, room, seat,
 * end time. Course code, teaching week, status flags and the school's
 * display string are dropped.
 *
 * @param {unknown} datas - the endpoint's `datas` array.
 * @returns {{tasks: object[], entries: object[]}}
 */
export function parseExams(datas) {
  const tasks = new Map()
  const entries = new Map()
  for (const item of Array.isArray(datas) ? datas : []) {
    if (item === null || typeof item !== 'object') continue
    const courseName = String(item.courseName ?? '').trim()
    const day = dayKeyOf(item.examDate)
    const start = String(item.startTime ?? '').trim()
    if (courseName === '' || day === null || !HHMM_RE.test(start)) continue
    const end = String(item.endTime ?? '').trim()
    const key = `${examKey(courseName)}\u0000${day}`
    const title = `${courseName} 考试`
    const due = `${day}T${start}:00+08:00`
    const description = examNotes(item, HHMM_RE.test(end) ? end : '')
    tasks.set(key, { key, title, description, taskType: 'exam', due, priority: 'high' })
    // A missing or invalid end still yields a deadline, never a fabricated block.
    if (HHMM_RE.test(end) && end > start) {
      entries.set(key, {
        sourceKey: `exam:${key}`, title, description,
        location: String(item.examPlace ?? '').trim() || null,
        start: due, end: `${day}T${end}:00+08:00`,
        category: 'exam', lock: true, allDay: false,
      })
    }
  }
  return { tasks: [...tasks.values()], entries: [...entries.values()] }
}

/**
 * Dedup key of an exam NAME. Legacy imports and earlier syncs stored either
 * the bare course name or the ` 考试` form, so both must meet here.
 */
export const examKey = title => String(title ?? '').replace(/\s*考试\s*$/, '').trim()

/** `"2025-11-16 00:00:00"` → `"2025-11-16"`; null when unusable. */
function dayKeyOf(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? '').trim())
  if (match === null) return null
  const [, y, m, d] = match
  const date = new Date(Number(y), Number(m) - 1, Number(d), 12, 0, 0, 0)
  // Round-trip: rejects 2025-02-30 and friends instead of silently rolling over.
  if (date.getFullYear() !== Number(y) || date.getMonth() !== Number(m) - 1
    || date.getDate() !== Number(d)) return null
  return `${y}-${m}-${d}`
}

/**
 * The one line worth reading before an exam: where, which seat, and when it
 * ends (the task model has no end field of its own).
 */
function examNotes(item, end) {
  const place = String(item.examPlace ?? '').trim()
  const seat = String(item.examSeatNo ?? '').trim()
  return [
    place === '' ? '' : `地点：${place}`,
    seat === '' ? '' : `座位：${seat}`,
    end === '' ? '' : `结束：${end}`,
  ].filter(Boolean).join('；') || null
}
