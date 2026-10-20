/**
 * @lidozs55/dsh-schedule-bridge — the schedule ⇄ vivarium bridge (docs 09 v2).
 *
 * Boundary (unchanged from the 09 v1 ruling, restated for the feed era):
 * timing policy and truth stay in the MAIN plugin (reminder subsystem owns
 * lead minutes and the ctx.schedule mirror; session delivery remains the
 * fallback). The bridge only adds PET SURFACES on top of two read faces:
 *
 *   1. Reminder notices — when a reminder moment arrives (task deadline,
 *      upcoming class, calendar entry — the core's derived set covers all
 *      three via the `kind` field), raise a sticky pet bubble (notice).
 *      Tasks get 「知道了」+「已完成」(tapping 已完成 completes the task
 *      straight from the bubble); classes/entries get 「知道了」 only —
 *      there is nothing to complete. Reads `scheduleCore.upcomingReminders()`
 *      so lead times live in exactly one place. Because that derived set
 *      only contains FUTURE moments, the poll fires within the ≤60s window
 *      before the moment — at most a minute early, never missed.
 *   2. Task state — report pending/overdue/next-deadline FACTS to the base
 *      (`vivarium.tasks.report`, contract §4c). The BASE derives the pet
 *      semantics (`tasks.overdue` worry edge, `tasks.clear` celebration), so
 *      every species reacts by binding base signals — none of them ever
 *      parses this bridge's payloads (ADR-013). `sched.data.changed` stays
 *      as a raw observability signal with no pet semantics.
 *
 * Host-only bundle: no client half, no UI, no data copy. Missing vivarium
 * or missing main plugin ⇒ cordis parks this bundle — the main plugin's
 * reminders and panel are unaffected either way.
 */
import Schema from '@deepseek-ai/schemastery'

export const inject = ['scheduleCore', 'vivarium']

export const Config = Schema.object({
  noticeOnReminder: Schema.boolean().default(true).description('提醒时刻到达时弹桌宠气泡（任务截止/上课/日程条目）'),
  statusSignals: Schema.boolean().default(true).description('向桌宠广播任务状态信号（待办/过期/下一截止）'),
})

/** One poll cycle of the reminder watch — also the max earliness of a bubble. */
const WATCH_LEAD_MS = 60_000
const NOTICE_TTL_MS = 30 * 60_000
const REPORT_INTERVAL_MS = 5 * 60_000

const TYPE_LABELS = { homework: '作业', exam: '考试', lecture: '听课', other: '截止事项' }
const ENTRY_LABELS = { course: '课程', homework: '作业', exam: '考试', meeting: '会议', study: '自习', sports: '运动', other: '日程' }

/** `YYYY-MM-DD` local day key (bundle-local; cannot import the main plugin). */
const dayKey = date => {
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const shortTime = iso => iso.replace('T', ' ').slice(0, 16)

const truncate = (text, cap) => (text.length > cap ? text.slice(0, cap - 1) + '…' : text)

export function apply(ctx, config) {
  const service = ctx.scheduleCore
  const vivarium = ctx.vivarium
  const raised = new Set() // notice ids posted during this activation

  // -- reminder notices -------------------------------------------------------
  // Per-kind presentation over ONE derived set (docs 09 §2.1): tasks can be
  // completed from the bubble; classes/entries are informational (「知道了」
  // only). `key` (taskId / class-<courseId>@<day> / entry-<id>) is the
  // deterministic dedup id — date-scoped where the source repeats, so the
  // bridge keeps no memory beyond the `raised` set.
  const noticeFor = reminder => {
    if (reminder.kind === 'class') {
      const room = reminder.classroom ? `（${reminder.classroom}）` : ''
      return {
        text: `「${truncate(reminder.title, 40)}」将于 ${shortTime(reminder.start)} 上课${room}，别迟到～`,
        actions: [{ id: 'ack', label: { zh: '知道了', en: 'Got it' } }],
      }
    }
    if (reminder.kind === 'entry') {
      const label = ENTRY_LABELS[reminder.category] ?? ENTRY_LABELS.other
      const when = reminder.allDay
        ? `${reminder.start.slice(0, 10)} 全天`
        : `将于 ${shortTime(reminder.start)} 开始`
      return {
        text: `「${label}」${truncate(reminder.title, 40)} ${when}，记得参加～`,
        actions: [{ id: 'ack', label: { zh: '知道了', en: 'Got it' } }],
      }
    }
    const typeLabel = TYPE_LABELS[reminder.taskType] ?? TYPE_LABELS.other
    return {
      text: `「${truncate(reminder.title, 40)}」将于 ${shortTime(reminder.due)} 截止（${typeLabel}），记得处理～`,
      actions: [
        { id: 'ack', label: { zh: '知道了', en: 'Got it' } },
        { id: 'complete', label: { zh: '已完成', en: 'Done' } },
      ],
    }
  }

  const watchReminders = () => {
    if (!config.noticeOnReminder) return
    const now = Date.now()
    for (const reminder of service.upcomingReminders()) {
      const at = Date.parse(reminder.at)
      // Fire inside the [at-60s, at+60s] window: one poll may straddle the
      // moment; earlier than that stays silent, later is already gone from
      // the derived set.
      if (at - now > WATCH_LEAD_MS || now - at > WATCH_LEAD_MS) continue
      const id = `sched-rem-${reminder.key ?? reminder.taskId}`
      if (raised.has(id)) continue
      const notice = noticeFor(reminder)
      const posted = vivarium.notices.post({
        id,
        text: notice.text,
        actions: notice.actions,
        ttlMs: NOTICE_TTL_MS,
        source: 'schedule-bridge',
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
            .catch(error => ctx.logger.warn('schedule-bridge: complete-from-bubble failed: %s', error.message))
        }
      }).catch(() => {})
    }
  }

  // -- task state report -------------------------------------------------------
  // Facts only (counts + next deadline): pet semantics — the overdue worry
  // edge and the all-clear celebration — are the BASE's to derive (§4c
  // tasks.report). This bridge translates its domain into the base
  // vocabulary once and remembers nothing (the old prevPending/cleared
  // tracking was base state memory sunk into the wrong layer).
  const canReportTasks = typeof vivarium.tasks?.report === 'function'
  if (config.statusSignals && !canReportTasks) {
    ctx.logger.warn('schedule-bridge: host vivarium lacks tasks.report (contract §4c) — task status reporting disabled')
  }
  const reportTasks = () => {
    if (!config.statusSignals || !canReportTasks) return
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
    vivarium.tasks.report({
      pending: overdue + dueToday + later,
      overdue,
      dueToday,
      next: next === null ? null : { title: next.title, due: next.due },
    })
  }

  ctx.effect(() => {
    const disposeWatch = vivarium.every(WATCH_LEAD_MS, () => {
      try {
        watchReminders()
      } catch (error) {
        ctx.logger.warn('schedule-bridge: reminder watch failed: %s', error.message)
      }
    })
    const disposeReport = vivarium.every(REPORT_INTERVAL_MS, () => {
      try {
        reportTasks()
      } catch (error) {
        ctx.logger.warn('schedule-bridge: task report failed: %s', error.message)
      }
    })
    return () => {
      disposeWatch()
      disposeReport()
    }
  }, 'schedule-bridge: timers')

  ctx.effect(() => {
    const dispose = service.subscribe(event => {
      try {
        if (config.statusSignals) {
          vivarium.emit({ type: 'sched.data.changed', payload: { tables: event.tables } })
        }
        reportTasks()
      } catch (error) {
        ctx.logger.warn('schedule-bridge: change handling failed: %s', error.message)
      }
    })
    return dispose
  }, 'schedule-bridge: subscription')

  watchReminders()
  reportTasks()
  ctx.logger.info('schedule-bridge: schedule ⇄ vivarium bridge active')
}
