/**
 * Reminder derivation (R2). No Session delivery, no `ctx.schedule`:
 * reminders are a UI notification concern, not an Agent automation task.
 *
 *   - TASK deadlines derive an `at` moment from the due time minus the
 *     configured lead.
 *   - SCHEDULE items (recurring classes via weekOccurrences + calendar
 *     entries — the 教务 import lands exams/meetings as entries) derive
 *     their moments from the start time minus the class/entry lead.
 *
 * Everything flows out through `service.upcomingReminders()`, sorted and
 * deduplicated by the consumer. Items carry `kind: 'task' | 'class' |
 * 'entry'` and a deterministic date-scoped `key`.
 *
 * Consumers are presentation surfaces, never Agent sessions:
 *   - the client half polls `GET /api/schedule-core?view=reminders` and
 *     raises a Web Notification (or an in-page toast when permission is
 *     absent) while the app is open;
 *   - the optional vivarium bridge turns the same set into pet bubbles.
 *
 * `remindersEnabled: false` turns the whole concept off: the derived set
 * is EMPTY, so every surface goes quiet together.
 */
import { today } from './semester.js'
import { deriveScheduleReminders, ENTRY_WINDOW_MS } from './schedule-reminders.js'

const leadMinutesFor = (config, taskType) =>
  taskType === 'exam' ? config.examLeadMinutes
    : taskType === 'homework' ? config.homeworkLeadMinutes
      : config.otherLeadMinutes

/**
 * Arm reminder derivation on the caller's context. Safe to call
 * unconditionally from `apply`; owns no storage and no session.
 * @param {object} config - the plugin Config (enabled flag + lead minutes).
 */
export function attachReminders(ctx, service, config) {
  if (!config.remindersEnabled) {
    service.upcomingReminders = () => []
    ctx.logger.info('sched-reminders: disabled by config')
    return
  }

  // The derived set (lead times applied) — the one face every surface reads.
  // It must EXIST unconditionally; the API and the bridge both poll it.
  const desiredTaskReminders = () => {
    const now = Date.now()
    const desired = []
    for (const task of service.listTasks({ scope: 'all', includeCompleted: false })) {
      const dueMs = new Date(task.due).getTime()
      const target = dueMs - leadMinutesFor(config, task.taskType) * 60_000
      if (!Number.isFinite(target) || !(target > now)) continue
      desired.push({
        kind: 'task',
        key: task.id,
        taskId: task.id,
        title: task.title,
        at: new Date(target).toISOString(),
        due: task.due,
        taskType: task.taskType,
      })
    }
    return desired
  }

  /** Classes + entries: derived fresh each call, never persisted. */
  const desiredScheduleReminders = () => {
    const nowMs = Date.now()
    return deriveScheduleReminders({
      occurrences: service.weekOccurrences(today()),
      entries: service.listEntries(new Date(nowMs).toISOString(), new Date(nowMs + ENTRY_WINDOW_MS).toISOString()),
      nowMs,
      classLeadMinutes: config.classLeadMinutes,
      examLeadMinutes: config.examLeadMinutes,
      eventLeadMinutes: config.eventLeadMinutes,
    })
  }

  service.upcomingReminders = () => [...desiredTaskReminders(), ...desiredScheduleReminders()]
}
