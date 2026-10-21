/** Import the whole BUAA term as one source-owned snapshot of ordinary entries. */
import { BuaaError, fetchExams, fetchSchedule, ssoLogin } from './jw.js'
import { examKey, parseTimetable, parseExams, studentIdOf } from './parse.js'
import { termCodeFor, termLabel } from './time.js'
import { SOURCE_ID } from './state.js'

/**
 * @param {object} deps - `{ service }`.
 * @param {object} creds - `{ buaaId?, password, termStart? }`. `password` is
 *   the SSO password for this call only — never stored. `termStart`
 *   (`YYYY-MM-DD`, Monday of week 1) lets an agent import without visiting
 *   the settings page first; it is written to the core meta.
 * @returns {object} summary for the tool and the settings card.
 */
export async function runSync({ service, jw = { ssoLogin, fetchSchedule, fetchExams } }, creds) {
  const password = typeof creds.password === 'string' ? creds.password : ''
  if (password === '') {
    throw new BuaaError('invalid_input', '缺少统一认证密码（仅当次使用，不保存）')
  }

  if (typeof creds.termStart === 'string' && creds.termStart !== '') {
    await service.setMeta({ termStart: creds.termStart })
  }
  const termStart = service.getMeta().termStart
  if (termStart === '') {
    throw new BuaaError('invalid_input',
      '缺少学期起始日期（第一周周一）：先在日程设置里填写，课表的周次才能换算成日期')
  }
  const termCode = termCodeFor(termStart)
  const buaaId = creds.buaaId || service.getSourceState(SOURCE_ID).buaaId
  if (!buaaId) throw new BuaaError('invalid_input', '缺少学号（先在设置或工具参数里提供）')

  const jar = await jw.ssoLogin(buaaId, password)

  const schedule = await jw.fetchSchedule(jar, termCode)
  const timetable = parseTimetable(schedule, termStart)
  if (!Array.isArray(schedule?.datas?.arrangedList) && !Array.isArray(schedule?.datas?.practiceList)) {
    throw new BuaaError('data',
      `教务返回了 ${termLabel(termCode)} 的课表，但缺少教学安排列表`
      + '（学期起始日期是否填成了别的学期？）')
  }

  let examDrafts
  let examFailure
  try {
    const response = await jw.fetchExams(jar, termCode)
    if (!Array.isArray(response?.datas)) throw new BuaaError('data', '考试安排缺少有效列表')
    examDrafts = parseExams(response.datas)
  } catch (error) {
    if (error.code === 'auth') throw error
    examFailure = error.message
  }
  const examEntries = examDrafts?.entries ?? service.listEntries()
    .filter(entry => entry.source === SOURCE_ID && entry.category === 'exam')
    .map(({ title, description, location, start, end, category, lock, allDay, sourceKey }) =>
      ({ title, description, location, start, end, category, lock, allDay, sourceKey }))
  const entries = await service.replaceSourceEntries(SOURCE_ID, [...timetable.entries, ...examEntries])
  const exams = examDrafts === undefined
    ? { created: 0, updated: 0, removed: 0, total: examEntries.length, failed: examFailure }
    : await syncExamTasks({ service }, examDrafts.tasks, termStart)

  const state = service.getSourceState(SOURCE_ID)
  const account = studentIdOf(schedule) || buaaId
  await service.setSourceState(SOURCE_ID, { ...state, buaaId: account, termCode })

  return {
    termCode, termLabel: termLabel(termCode), termStart,
    weeksCovered: timetable.weeksCovered,
    entries, teaching: timetable.entries.length, exams,
  }
}

/**
 * Reconcile the term's exam list against the stored exam tasks.
 *
 * Identity is (course name, exam date), never the name alone: one course can
 * sit a mid-term and a final in the same term, and a name-only key would
 * silently merge them. Matching spans ALL sources, so a task the user added
 * by hand for the same exam is reused instead of duplicated; a task we own is
 * refreshed in full, a foreign one only has its `due` corrected (its title,
 * priority and notes are the user's).
 *
 * Deletion is deliberately narrow: only tasks this source created, and only
 * within the term being synced (not dated before the term anchor) — a
 * cancelled or moved exam disappears, but a previous term's exam history is
 * never touched.
 */
async function syncExamTasks({ service }, drafts, termStart) {
  const dayOf = task => String(task.due ?? '').slice(0, 10)
  const taskKey = task => `${examKey(task.title)}\u0000${dayOf(task)}`
  const existingByKey = new Map(service.listTasks({ scope: 'all' })
    .filter(task => task.taskType === 'exam')
    .map(task => [taskKey(task), task]))

  let created = 0
  let updated = 0
  for (const draft of drafts) {
    const { key, ...fields } = draft
    const existing = existingByKey.get(key)
    if (existing === undefined) {
      await service.createTask({ ...fields, source: SOURCE_ID })
      created += 1
      continue
    }
    existingByKey.delete(key)
    const owned = existing.source === SOURCE_ID
    const stale = existing.due !== fields.due
      || (owned && (existing.description !== fields.description
        || existing.priority !== fields.priority
        || existing.taskType !== fields.taskType))
    if (!stale) continue
    await service.updateTask(existing.id, owned ? { ...fields } : { due: fields.due })
    updated += 1
  }

  let removed = 0
  for (const leftover of existingByKey.values()) {
    if (leftover.source !== SOURCE_ID) continue
    if (dayOf(leftover) < termStart) continue
    await service.deleteTask(leftover.id)
    removed += 1
  }
  return { created, updated, removed, total: drafts.length }
}