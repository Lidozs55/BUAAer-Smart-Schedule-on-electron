/**
 * @buaaer/dsh-schedule-reminders — the satellite reminder plugin (R2).
 *
 * Hard-injects the main plugin's `buaaerSchedule` service (main plugin
 * absent ⇒ this row stays quietly inactive) and mirrors task deadlines
 * into `ctx.schedule` one-shot `at` reminders bound to one dedicated
 * session. `ctx.schedule` itself is OPTIONAL (the「自动化任务」bundle) —
 * without it this plugin degrades to a log line, never an error.
 *
 * ── Bridge seam (dsh-vivarium) ─────────────────────────────────────────
 * A future bridge plugin should attach HERE, not inside the main plugin:
 * consume `buaaerSchedule.subscribe()` (or this module's derived set) and
 * keep its own delivery surface. Nothing below may grow desktop-pet
 * concerns; nothing above may learn about delivery.
 * ────────────────────────────────────────────────────────────────────────
 *
 * Reminder identity: the schedule record's title starts with
 * `[buaaer:<taskId>]`, which is how resyncs recognize their own records
 * without extra storage.
 */
import Schema from '@deepseek-ai/schemastery'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

export const inject = ['buaaerSchedule']

export const Config = Schema.object({
  homeworkLeadMinutes: Schema.number().default(30).description('作业类提醒提前分钟数'),
  examLeadMinutes: Schema.number().default(1440).description('考试类提醒提前分钟数'),
  otherLeadMinutes: Schema.number().default(30).description('其他任务提醒提前分钟数'),
})

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

export async function apply(ctx, config) {
  const schedule = ctx.get('schedule')
  const sessionController = ctx.get('sessionController')
  const storageDomain = ctx.get('storageDomain')
  if (!schedule) {
    ctx.logger.info('buaaer-reminders: ctx.schedule absent (enable「自动化任务」to arm reminders); plugin idles')
    return
  }
  if (!sessionController || !storageDomain) {
    ctx.logger.info('buaaer-reminders: session/storage seams absent in this profile; plugin idles')
    return
  }

  const service = ctx.buaaerSchedule
  const domain = await storageDomain.open(remindersDomainSpec)
  ctx.effect(() => () => { void domain.close() }, 'buaaer-reminders: domain close')

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
      const label = `${TITLE_PREFIX}${task.id}] ${task.title}`.slice(0, MAX_TITLE)
      desired.set(task.id, {
        title: label,
        at: new Date(target).toISOString(),
        prompt: `日程提醒：任务「${task.title}」将于 ${task.due} 截止（${task.taskType}）。请提醒用户。`,
      })
    }
    return desired
  }

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

  ctx.effect(() => {
    const dispose = service.subscribe(() => { void resync() })
    void resync()
    return dispose
  }, 'buaaer-reminders: subscription')
}
