/** Import the whole BUAA term as one source-owned snapshot of ordinary entries. */
import { BuaaError, fetchExams, fetchSchedule, ssoLogin } from './jw.js'
import { examKey, parseTimetable, parseExams, studentIdOf } from './parse.js'
import { syncSpocTasks } from './spoc-sync.js'
import { termCodeFor, termLabel } from './time.js'
import { SOURCE_ID } from './state.js'

/**
 * @param {object} deps - `{ service, jw?, spoc?, signin? }`.
 * @param {object} creds - `{ buaaId?, password, termStart? }`. `password` is
 *   the SSO password for this call only — never stored. `termStart`
 *   (`YYYY-MM-DD`, Monday of week 1) lets an agent import without visiting
 *   the settings page first; it is written to the core meta.
 * @returns {object} summary for the tool and the settings card.
 */
export async function runSync(
  { service, jw = { ssoLogin, fetchSchedule, fetchExams }, spoc = null, signin = null, isActive = () => true },
  creds,
) {
  const assertActive = () => {
    if (!isActive()) throw new BuaaError('cancelled', '北航来源插件已停用，请重新启用后同步')
  }
  assertActive()
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
  if (!buaaId) throw new BuaaError('invalid_input', '缺少学号（先在设置或命令参数里提供）')
  for (const client of [spoc, signin]) {
    const username = client?.sessionSnapshot?.()?.username
    if (username !== undefined && username !== buaaId) client.clearSession?.()
  }

  const jar = await jw.ssoLogin(buaaId, password)
  assertActive()

  const schedule = await jw.fetchSchedule(jar, termCode)
  assertActive()
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
  assertActive()
  const examEntries = examDrafts?.entries ?? service.listEntries()
    .filter(entry => entry.source === SOURCE_ID && entry.sourceKey?.startsWith('exam:'))
    .map(({ title, description, location, start, end, category, lock, allDay, sourceKey }) =>
      ({ title, description, location, start, end, category, lock, allDay, sourceKey }))
  const entries = await service.replaceSourceEntries(SOURCE_ID, [...timetable.entries, ...examEntries])
  const exams = examDrafts === undefined
    ? { created: 0, updated: 0, removed: 0, total: examEntries.length, failed: examFailure }
    : await syncExamTasks({ service }, examDrafts.tasks, termStart)

  const state = service.getSourceState(SOURCE_ID)
  const account = studentIdOf(schedule) || buaaId
  await service.setSourceState(SOURCE_ID, { ...state, buaaId: account, termCode })

  const summary = {
    termCode, termLabel: termLabel(termCode), termStart,
    weeksCovered: timetable.weeksCovered,
    entries, teaching: timetable.entries.length, exams,
  }

  // SPOC is a second application behind the same CAS, not part of the JW
  // snapshot. It runs after the timetable is safely written and never fails
  // the JW import: an unreachable or changed SPOC only degrades the homework
  // half, and the user still gets the term they asked for.
  assertActive()
  if (spoc !== null && state.spocEnabled !== false) {
    summary.spoc = await syncSpocAssignments({
      service, spoc, jar, username: account, password, termStart,
    })
  }

  // The remote check-in button is clicked long after this call returns, so
  // the manual sync is the only moment that still has the password and the
  // SSO jar. Establish iclass's memory-only session now; like SPOC, a failure
  // is a warning on the card, never a failed JW import.
  assertActive()
  if (signin !== null) {
    summary.signin = await syncSigninSession({
      service, signin, jar, username: account, password,
    })
  }
  return summary
}

async function saveSpocState(service, patch) {
  const state = service.getSourceState(SOURCE_ID)
  await service.setSourceState(SOURCE_ID, { ...state, ...patch })
}

async function recordSpocFailure(service, error) {
  try {
    await saveSpocState(service, { spocError: error.message ?? String(error) })
  } catch {
    // The task writes already succeeded or failed on their own; losing the
    // diagnostic must not turn a JW import into a failed import.
  }
}

async function syncSigninSession({ service, signin, jar, username, password }) {
  try {
    await signin.acquireSession({ jar, username, password })
    await saveSpocState(service, { signinError: '' })
    return { ready: true }
  } catch (error) {
    try {
      await saveSpocState(service, { signinError: error.message ?? String(error) })
    } catch {
      // Same rule as SPOC: diagnostics must not fail the import.
    }
    return { failed: error.message ?? String(error), code: error.code ?? 'error' }
  }
}

async function syncSpocAssignments({ service, spoc, jar, username, password, termStart }) {
  const staleReason = () => {
    const state = service.getSourceState(SOURCE_ID)
    if (state.spocEnabled === false) return 'disabled'
    if (state.buaaId !== username) return 'account_changed'
    if (service.getMeta().termStart !== termStart) return 'term_changed'
    return null
  }
  try {
    const feed = await spoc.fetchAssignments({ jar, username, password })
    const stale = staleReason()
    if (stale !== null) return { skipped: stale }
    if (String(feed.termCode ?? '').replaceAll('-', '') !== termCodeFor(termStart).replaceAll('-', '')) {
      throw new BuaaError('term_mismatch', 'SPOC 当前学期与日程学期不一致，保留已有待办')
    }
    const summary = await syncSpocTasks({ service }, feed, { termStart })
    await saveSpocState(service, {
      spocTermCode: feed.termCode ?? '',
      spocLastSyncAt: new Date().toISOString(),
      spocError: '',
    })
    return {
      ...summary,
      termCode: feed.termCode ?? '',
      termName: feed.termName ?? null,
    }
  } catch (error) {
    const stale = staleReason()
    if (stale !== null) return { skipped: stale }
    await recordSpocFailure(service, error)
    return { failed: error.message ?? String(error), code: error.code ?? 'error' }
  }
}

/**
 * Background tick: use only the in-memory SPOC session, never credentials.
 * The host keeps the session alive for as long as the process runs; after a
 * restart `hasSession()` is false and this becomes a no-op until the user
 * runs one manual sync. Errors are recorded for the settings card instead of
 * throwing into the timer.
 */
export async function runSpocPoll({ service, spoc = null }) {
  if (spoc === null || typeof spoc.refreshAssignments !== 'function') {
    return { skipped: 'unavailable' }
  }
  if (service.getSourceState(SOURCE_ID).spocEnabled === false) return { skipped: 'disabled' }
  if (typeof spoc.hasSession === 'function' && !spoc.hasSession()) {
    return { skipped: 'no_session' }
  }
  const termStart = service.getMeta().termStart
  if (termStart === '') return { skipped: 'no_term' }
  const username = spoc.sessionSnapshot?.()?.username
  const staleReason = () => {
    const state = service.getSourceState(SOURCE_ID)
    if (state.spocEnabled === false) return 'disabled'
    const currentUsername = spoc.sessionSnapshot?.()?.username
    if (username !== undefined && (state.buaaId !== username
      || (currentUsername !== undefined && currentUsername !== username))) return 'account_changed'
    if (service.getMeta().termStart !== termStart) return 'term_changed'
    return null
  }
  const stale = staleReason()
  if (stale !== null) return { skipped: stale }

  try {
    const feed = await spoc.refreshAssignments()
    const stale = staleReason()
    if (stale !== null) return { skipped: stale }
    if (String(feed.termCode ?? '').replaceAll('-', '') !== termCodeFor(termStart).replaceAll('-', '')) {
      throw new BuaaError('term_mismatch', 'SPOC 当前学期与日程学期不一致，保留已有待办')
    }
    const summary = await syncSpocTasks({ service }, feed, { termStart })
    await saveSpocState(service, {
      spocTermCode: feed.termCode ?? '',
      spocLastSyncAt: new Date().toISOString(),
      spocError: '',
    })
    return {
      ...summary,
      termCode: feed.termCode ?? '',
      termName: feed.termName ?? null,
    }
  } catch (error) {
    const stale = staleReason()
    if (stale !== null) return { skipped: stale }
    await recordSpocFailure(service, error)
    return { failed: error.message ?? String(error), code: error.code ?? 'error' }
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