/**
 * Reminder subsystem (R2). Two derivations, one policy home:
 *   - TASK deadlines mirror into `ctx.schedule` one-shot `at` reminders
 *     bound to one dedicated delivery session (the automation bundle is the
 *     fallback surface when the pet bubble is missed).
 *   - SCHEDULE items (recurring classes via weekOccurrences + calendar
 *     entries — the 教务 import lands exams/meetings as entries) derive
 *     reminder moments WITHOUT mirroring: one agent prompt per class
 *     meeting is spam, the pet bubble is the surface (docs 09 §2.1).
 * Both flow out through `service.upcomingReminders()` — items carry
 * `kind: 'task' | 'class' | 'entry'` and a deterministic date-scoped
 * `key` for bridge-side dedup.
 *
 * Degradation ladder (each rung narrower than the last):
 *   - `remindersEnabled: false` → the whole concept is off, derived set is
 *     EMPTY (docs 09 §2.1 策略一致性).
 *   - `ctx.schedule`/`sessionController` absent → only MIRRORING (session
 *     fallback) idles; the derived set keeps flowing — the pet bubble
 *     surface never needed the automation bundle.
 *   - domain open()/resync failures disable mirroring, never the calendar.
 *
 * Bridge seam (dsh-vivarium, docs 09): timing policy (lead minutes) lives
 * here and nowhere else; delivery surfaces are the bridge's concern.
 *
 * Reminder identity: schedule record titles start with `[sched:<taskId>]`,
 * which is how resyncs recognize their own records without extra storage.
 */
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { today } from './semester.js'
import { deriveScheduleReminders, ENTRY_WINDOW_MS } from './schedule-reminders.js'

const remindersDomainSpec = defineDomain({
  name: 'sched_reminders',
  version: 1,
  tables: {},
  global: {
    schema: z.object({ boundSessionId: z.string() }),
    initial: { boundSessionId: '' },
  },
})

const TITLE_PREFIX = '[sched:'
const MAX_TITLE = 120

const leadMinutesFor = (config, taskType) =>
  taskType === 'exam' ? config.examLeadMinutes
    : taskType === 'homework' ? config.homeworkLeadMinutes
      : config.otherLeadMinutes

const recordTaskId = title => {
  if (!title.startsWith(TITLE_PREFIX)) return null
  const end = title.indexOf(']')
  return end > TITLE_PREFIX.length ? title.slice(TITLE_PREFIX.length, end) : null
}

const recordAt = record => (record.at !== undefined ? new Date(record.at).getTime() : null)

/**
 * Arm reminder mirroring on the caller's context. Safe to call
 * unconditionally from `apply` — registers its own effect, never throws.
 * @param {object} config - the plugin Config (enabled flag + lead minutes).
 */
export function attachReminders(ctx, service, config) {
  if (!config.remindersEnabled) {
    service.upcomingReminders = () => []
    ctx.logger.info('sched-reminders: disabled by config')
    return
  }

  // The derived set (lead times applied) — the one face bridges read. It
  // must EXIST unconditionally (a missing accessor would crash a bridge's
  // poll) and it deliberately does not require the automation bundle: only
  // session mirroring below does.
  const desiredTaskReminders = () => {
    const now = Date.now()
    const desired = new Map()
    for (const task of service.listTasks({ scope: 'all', includeCompleted: false })) {
      const dueMs = new Date(task.due).getTime()
      const target = dueMs - leadMinutesFor(config, task.taskType) * 60_000
      if (!(target > now)) continue
      desired.set(task.id, {
        kind: 'task',
        key: task.id,
        taskId: task.id,
        title: `${TITLE_PREFIX}${task.id}] ${task.title}`.slice(0, MAX_TITLE),
        at: new Date(target).toISOString(),
        due: task.due,
        taskType: task.taskType,
        prompt: `日程提醒：任务「${task.title}」将于 ${task.due} 截止（${task.taskType}）。请提醒用户。`,
      })
    }
    return desired
  }

  /** Classes + entries: derived fresh each call, never mirrored (docs 09 §2.1). */
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

  service.upcomingReminders = () => [...desiredTaskReminders().values(), ...desiredScheduleReminders()]

  const schedule = ctx.get('schedule')
  const sessionController = ctx.get('sessionController')
  if (!schedule) {
    ctx.logger.info('sched-reminders: ctx.schedule absent (enable「自动化任务」for session fallback); mirroring idles')
    return
  }
  if (!sessionController) {
    ctx.logger.info('sched-reminders: sessionController seam absent in this profile; mirroring idles')
    return
  }

  let closed = false
  ctx.effect(() => {
    let disposeWire = () => {}
    // A reminder-store problem must disable mirroring, not the plugin.
    void (async () => {
      try {
        const domain = await ctx.storageDomain.open(remindersDomainSpec)
        if (closed) {
          void domain.close()
          return
        }
        disposeWire = wire(ctx, { service, config, schedule, sessionController, domain, desiredTaskReminders })
      } catch (error) {
        ctx.logger.warn('sched-reminders: mirroring disabled (%s)', error.message)
      }
    })()
    return () => {
      closed = true
      disposeWire()
    }
  }, 'schedule: reminders')
}

function wire(ctx, { service, config, schedule, sessionController, domain, desiredTaskReminders }) {
  let boundSessionId = domain.global.get().boundSessionId

  /** The one session reminders deliver into; created once, then reused. */
  const ensureSession = async () => {
    if (boundSessionId !== '') return boundSessionId
    const created = await sessionController.create({})
    boundSessionId = created.sessionId
    await domain.global.set({ boundSessionId })
    ctx.logger.info('sched-reminders: bound to session %s', boundSessionId)
    return boundSessionId
  }

  let resyncing = false
  const resync = async () => {
    if (resyncing) return
    resyncing = true
    try {
      const sessionId = await ensureSession()
      const desired = desiredTaskReminders()
      const records = await schedule.list({ sessionId })
      const seen = new Set()
      for (const record of records) {
        const taskId = recordTaskId(record.title ?? '')
        const want = taskId !== null ? desired.get(taskId) : undefined
        const at = recordAt(record)
        const match = want !== undefined
          && want.title === record.title
          && at !== null && at === new Date(want.at).getTime()
        if (match) {
          seen.add(taskId)
        } else if (taskId !== null) {
          await schedule.delete({ sessionId, id: record.id })
        }
      }
      for (const [taskId, want] of desired) {
        if (seen.has(taskId)) continue
        await schedule.create(sessionId, {
          title: want.title,
          prompt: want.prompt,
          at: want.at,
        })
      }
    } catch (error) {
      ctx.logger.warn('sched-reminders: resync failed: %s', error.message)
    } finally {
      resyncing = false
    }
  }

  const dispose = service.subscribe(() => { void resync() })
  void resync()
  return dispose
}
