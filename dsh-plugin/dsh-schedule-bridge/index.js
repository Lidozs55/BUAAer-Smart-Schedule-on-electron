/**
 * @lidozs55/dsh-schedule-bridge — the schedule ⇄ vivarium bridge (docs 09 v2).
 *
 * Boundary (unchanged from the 09 v1 ruling, restated for the feed era):
 * timing policy and truth stay in the MAIN plugin (reminder subsystem owns
 * lead minutes and the ctx.schedule mirror; session delivery remains the
 * fallback). The bridge only adds PET SURFACES on top of two read faces:
 *
 *   1. Reminder notices — when a task's reminder moment arrives, raise a
 *      sticky pet bubble (notice) with 「知道了」 and 「已完成」 actions.
 *      Tapping 已已完成 the task straight from the bubble; 确认 ≠ 完成
 *      otherwise. Reads `buaaerSchedule.upcomingReminders()` so lead times
 *      live in exactly one place. Because that derived set only contains
 *      FUTURE moments, the poll fires within the ≤60s window before the
 *      moment — at most a minute early, never missed.
 *   2. Status signals — broadcast `buaaer.tasks.updated` (counts + next
 *      deadline) and `buaaer.data.changed` so species packs can react
 *      (worry at overdue, celebrate at all-done, badge the next due).
 *      Signal names ride the bridge's own `buaaer.` prefix (contract §4).
 *
 * Host-only bundle: no client half, no UI, no data copy. Missing vivarium
 * or missing main plugin ⇒ cordis parks this bundle — the main plugin's
 * reminders and panel are unaffected either way.
 */
import Schema from '@deepseek-ai/schemastery'

export const inject = ['buaaerSchedule', 'vivarium']

export const Config = Schema.object({
  noticeOnReminder: Schema.boolean().default(true).description('截止提醒到达时弹桌宠确认气泡（带「已完成」快捷动作）'),
  statusSignals: Schema.boolean().default(true).description('向桌宠广播任务状态信号（待办/过期/下一截止）'),
})

/** One poll cycle of the reminder watch — also the max earliness of a bubble. */
const WATCH_LEAD_MS = 60_000
const NOTICE_TTL_MS = 30 * 60_000
const SIGNAL_INTERVAL_MS = 5 * 60_000

const TYPE_LABELS = { homework: '作业', exam: '考试', lecture: '听课', other: '截止事项' }

/** `YYYY-MM-DD` local day key (bundle-local; cannot import the main plugin). */
const dayKey = date => {
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const shortTime = iso => iso.replace('T', ' ').slice(0, 16)

const truncate = (text, cap) => (text.length > cap ? text.slice(0, cap - 1) + '…' : text)

export function apply(ctx, config) {
  const service = ctx.buaaerSchedule
  const vivarium = ctx.vivarium
  const raised = new Set() // notice ids posted during this activation

  // -- reminder notices -------------------------------------------------------
  const watchReminders = () => {
    if (!config.noticeOnReminder) return
    const now = Date.now()
    for (const reminder of service.upcomingReminders()) {
      const at = Date.parse(reminder.at)
      // Fire inside the [at-60s, at+60s] window: one poll may straddle the
      // moment; earlier than that stays silent, later is already gone from
      // the derived set.
      if (at - now > WATCH_LEAD_MS || now - at > WATCH_LEAD_MS) continue
      const id = `buaaer-rem-${reminder.taskId}-${reminder.due}`
      if (raised.has(id)) continue
      const typeLabel = TYPE_LABELS[reminder.taskType] ?? TYPE_LABELS.other
      const posted = vivarium.notices.post({
        id,
        text: `「${truncate(reminder.title, 40)}」将于 ${shortTime(reminder.due)} 截止（${typeLabel}），记得处理～`,
        actions: [
          { id: 'ack', label: { zh: '知道了', en: 'Got it' } },
          { id: 'complete', label: { zh: '已完成', en: 'Done' } },
        ],
        ttlMs: NOTICE_TTL_MS,
        source: 'buaaer-schedule-bridge',
      })
      if (!posted.ok) {
        // duplicate-id = this reminder already has a live bubble.
        if (posted.code === 'duplicate-id') raised.add(id)
        continue
      }
      raised.add(id)
      // The tapped action id settles the promise (`ack` / `complete` / `expired`).
      vivarium.notices.settled(id).then(outcome => {
        if (outcome === 'complete') {
          service.setTaskCompleted(reminder.taskId, true)
            .catch(error => ctx.logger.warn('buaaer-bridge: complete-from-bubble failed: %s', error.message))
        }
      }).catch(() => {})
    }
  }

  // -- status signals ---------------------------------------------------------
  const emitTasks = () => {
    if (!config.statusSignals) return
    const now = Date.now()
    const today = dayKey(new Date())
    let overdue = 0
    let dueToday = 0
    let later = 0
    let next = null
    for (const task of service.listTasks({ scope: 'all', includeCompleted: false })) {
      const dueMs = Date.parse(task.due)
      if (dueMs < now) {
        overdue += 1
        continue
      }
      if (task.due.slice(0, 10) === today) dueToday += 1
      else later += 1
      if (next === null || dueMs < Date.parse(next.due)) next = task
    }
    vivarium.emit({
      type: 'buaaer.tasks.updated',
      payload: {
        pending: overdue + dueToday + later,
        overdue,
        dueToday,
        next: next === null ? null : { title: next.title, due: next.due },
      },
    })
  }

  ctx.effect(() => {
    const disposeWatch = vivarium.every(WATCH_LEAD_MS, () => {
      try {
        watchReminders()
      } catch (error) {
        ctx.logger.warn('buaaer-bridge: reminder watch failed: %s', error.message)
      }
    })
    const disposeSignal = vivarium.every(SIGNAL_INTERVAL_MS, () => {
      try {
        emitTasks()
      } catch (error) {
        ctx.logger.warn('buaaer-bridge: status signal failed: %s', error.message)
      }
    })
    return () => {
      disposeWatch()
      disposeSignal()
    }
  }, 'buaaer-bridge: timers')

  ctx.effect(() => {
    const dispose = service.subscribe(event => {
      try {
        if (config.statusSignals) {
          vivarium.emit({ type: 'buaaer.data.changed', payload: { tables: event.tables } })
        }
        emitTasks()
      } catch (error) {
        ctx.logger.warn('buaaer-bridge: change signal failed: %s', error.message)
      }
    })
    return dispose
  }, 'buaaer-bridge: subscription')

  watchReminders()
  emitTasks()
  ctx.logger.info('buaaer-bridge: schedule ⇄ vivarium bridge active')
}
