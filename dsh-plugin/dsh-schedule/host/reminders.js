/**
 * Reminder mirroring subsystem (R2): projects task deadlines into
 * `ctx.schedule` one-shot `at` reminders bound to one dedicated delivery
 * session. Everything here is deliberately optional and degrading —
 * `schedule` (the「自动化任务」bundle) and `sessionController` are read with
 * `ctx.get`, and open()/resync failures disable mirroring without ever
 * taking the calendar down.
 *
 * Bridge seam (dsh-vivarium, docs 09): future bridges consume
 * `service.upcomingReminders()` for their bubble surface. Timing policy
 * (lead minutes) lives here and nowhere else; delivery surfaces are the
 * bridge's concern.
 *
 * Reminder identity: schedule record titles start with `[buaaer:<taskId>]`,
 * which is how resyncs recognize their own records without extra storage.
 */
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

const remindersDomainSpec = defineDomain({
  name: 'buaaer_reminders',
  version: 1,
  tables: {},
  global: {
    schema: z.object({ boundSessionId: z.string() }),
    initial: { boundSessionId: '' },
  },
})

const TITLE_PREFIX = '[buaaer:'
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
  const schedule = ctx.get('schedule')
  const sessionController = ctx.get('sessionController')
  if (!config.remindersEnabled) {
    ctx.logger.info('buaaer-reminders: disabled by config')
    return
  }
  if (!schedule) {
    ctx.logger.info('buaaer-reminders: ctx.schedule absent (enable「自动化任务」to arm reminders); subsystem idles')
    return
  }
  if (!sessionController) {
    ctx.logger.info('buaaer-reminders: sessionController seam absent in this profile; subsystem idles')
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
        disposeWire = wire(ctx, { service, config, schedule, sessionController, domain })
      } catch (error) {
        ctx.logger.warn('buaaer-reminders: mirroring disabled (%s)', error.message)
      }
    })()
    return () => {
      closed = true
      disposeWire()
    }
  }, 'buaaer: reminders')
}

function wire(ctx, { service, config, schedule, sessionController, domain }) {
  let boundSessionId = domain.global.get().boundSessionId

  /** The one session reminders deliver into; created once, then reused. */
  const ensureSession = async () => {
    if (boundSessionId !== '') return boundSessionId
    const created = await sessionController.create({})
    boundSessionId = created.sessionId
    await domain.global.set({ boundSessionId })
    ctx.logger.info('buaaer-reminders: bound to session %s', boundSessionId)
    return boundSessionId
  }

  const desiredReminders = () => {
    const now = Date.now()
    const desired = new Map()
    for (const task of service.listTasks({ scope: 'all', includeCompleted: false })) {
      const dueMs = new Date(task.due).getTime()
      const target = dueMs - leadMinutesFor(config, task.taskType) * 60_000
      if (!(target > now)) continue
      desired.set(task.id, {
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

  // The one derived set (lead times applied) future bridges read.
  service.upcomingReminders = () => [...desiredReminders().values()]

  let resyncing = false
  const resync = async () => {
    if (resyncing) return
    resyncing = true
    try {
      const sessionId = await ensureSession()
      const desired = desiredReminders()
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
      ctx.logger.warn('buaaer-reminders: resync failed: %s', error.message)
    } finally {
      resyncing = false
    }
  }

  const dispose = service.subscribe(() => { void resync() })
  void resync()
  return dispose
}
