/** Stateless task and calendar-entry reminders, consumed by UI surfaces. */
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

  /** Entries: derived fresh each call, never persisted. */
  const desiredScheduleReminders = () => {
    const nowMs = Date.now()
    return deriveScheduleReminders({
      entries: service.listEntries(new Date(nowMs).toISOString(), new Date(nowMs + ENTRY_WINDOW_MS).toISOString()),
      nowMs,
      examLeadMinutes: config.examLeadMinutes,
      eventLeadMinutes: config.eventLeadMinutes,
    })
  }

  service.upcomingReminders = () => [...desiredTaskReminders(), ...desiredScheduleReminders()]
}
