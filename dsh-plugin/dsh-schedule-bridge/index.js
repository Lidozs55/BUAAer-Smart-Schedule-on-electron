/**
 * @lidozs55/dsh-schedule-bridge — the schedule ⇄ vivarium bridge (docs 09 v2).
 *
 * Boundary (unchanged from the 09 v1 ruling, restated for the feed era):
 * timing policy and truth stay in the MAIN plugin (reminder subsystem owns
 * lead minutes and the derived set; the main plugin's client poller is the
 * core-owned Web Notification/toast surface). The bridge only adds PET
 * SURFACES on top of two read faces:
 *
 *   1. Reminder notices — when a reminder moment arrives (task deadline,
 *      calendar entry — the core's derived set covers both via the `kind` field), raise a sticky pet bubble (notice).
 *      Tasks get 「知道了」+「已完成」(tapping 已完成 completes the task
 *      straight from the bubble); entries get 「知道了」 only —
 *      there is nothing to complete. Reads `scheduleCore.upcomingReminders()`
 *      so lead times live in exactly one place. Because that derived set
 *      only contains FUTURE moments, the poll fires within the ≤60s window
 *      before the moment — at most a minute early, never missed.
 *   2. Task state — report pending/overdue/next-deadline FACTS to the base
 *      (`vivarium.tasks.report`, contract §4c). The BASE derives the pet
 *      semantics (`tasks.overdue` worry edge, `tasks.clear` celebration), so
 *      every species reacts by binding base signals — none of them ever
 *      parses this bridge's payloads (vivarium contract §4c). `sched.data.changed` stays
 *      as a raw observability signal with no pet semantics.
 *   3. Pet drops — text and/or images dragged onto the pet
 *      (`vivarium.drops.onDrop`, §4d) are staged in the schedule core's
 *      in-memory drop queue. The pet notice asks 「确认」; that action marks
 *      the row confirmed and the schedule client opens a new Agent session
 *      directly (no clipboard step). The bridge never parses text or OCRs
 *      images (no LLM call, no task guess).
 *   4. Session answers — for a while after a drop session is delivered, the
 *      session's `user-questions/request` / `approval/request` waterfalls are
 *      claimed (prepended, ahead of the platform UI forwarder) and surfaced
 *      as pet bubbles; a tap is returned as the answer, an expired bubble
 *      delegates back to the session UI. The prompt contract (two-option
 *      yes/no questions) keeps those bubbles answerable from the pet.
 *
 * Host-only bundle: no client half, no UI, no data copy. Missing vivarium
 * or missing main plugin ⇒ cordis parks this bundle — the main plugin's
 * reminders and panel are unaffected either way.
 */
import Schema from '@deepseek-ai/schemastery'
import { attachBridge } from './bridge.js'

export const inject = ['scheduleCore', 'vivarium']

export const Config = Schema.object({
  noticeOnReminder: Schema.boolean().default(true).description('提醒时刻到达时弹桌宠气泡（任务截止/日程条目）'),
  statusSignals: Schema.boolean().default(true).description('向基座上报任务状态事实（待办/过期/下一截止），宠物语义由基座推导'),
  dropToAgent: Schema.boolean().default(true).description('文本/图片拖到桌宠后，确认即新建会话交给 Agent 解析并新建日程'),
})

export function apply(ctx, config) {
  attachBridge(ctx, config)
}
