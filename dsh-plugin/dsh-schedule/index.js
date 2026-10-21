/**
 * Host half of @lidozs55/dsh-schedule — the generic schedule core.
 *
 * Opens the storage domain, exposes the `scheduleCore` service, then wires
 * the generic Agent tools, stateless reminder derivation, prompt section,
 * and client `/api` channel. Calendar sources (school portals, export
 * formats) are separate bundles that inject `scheduleCore` and write
 * through this service; they never share the core's storage handle.
 *
 * Every consumed service is declared here — `ctx.get` is only an immediate
 * lookup, so an undeclared service can be absent at apply time purely by
 * activation order (the connection race that left the client data channel
 * 404). cordis parks the package until declared providers activate, which
 * is the deterministic contract; these four come from the base + web-app
 * bundles every web/desktop deployment mounts. The `if (…)` guards below
 * stay as defensive fallbacks, not the primary mechanism.
 */
import Schema from '@deepseek-ai/schemastery'
import { scheduleDomainSpec } from './host/domain.js'
import { registerClientApi } from './host/api.js'
import { attachReminders } from './host/reminders.js'
import { createScheduleService } from './host/service.js'
import { registerScheduleTools } from './host/tools.js'
import { termWeek, today } from './host/semester.js'

export const inject = ['storageDomain', 'tools', 'connection', 'systemPrompt']

/** Reminder kill switch and lead times — the core's only Config. */
export const Config = Schema.object({
  remindersEnabled: Schema.boolean().default(true).description('启用提醒（关闭后派生集为空，页面通知与桌宠气泡同步静默）'),
  homeworkLeadMinutes: Schema.number().default(30).description('作业类提醒提前分钟数'),
  examLeadMinutes: Schema.number().default(1440).description('考试类提醒提前分钟数（任务与考试条目同用）'),
  otherLeadMinutes: Schema.number().default(30).description('其他任务提醒提前分钟数'),
  classLeadMinutes: Schema.number().default(10).description('上课提醒提前分钟数'),
  eventLeadMinutes: Schema.number().default(15).description('日程条目提醒提前分钟数（考试类条目改用考试提前量）'),
})

export async function apply(ctx, config) {
  // open() throws loudly on backend/facet/schema mismatch — activation
  // must fail rather than present an empty schedule.
  const domain = await ctx.storageDomain.open(scheduleDomainSpec)
  ctx.effect(() => () => { void domain.close() }, 'schedule: domain close')

  const service = createScheduleService(ctx, domain)
  ctx.effect(() => ctx.provide('scheduleCore', service), 'schedule: service')

  ctx.effect(() => registerScheduleTools(ctx, service), 'schedule: tools')

  // Stateless reminder derivation (R2): no storage, no Session, no
  // `ctx.schedule`; presentation surfaces poll it.
  attachReminders(ctx, service, config)

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt) {
    ctx.effect(() => systemPrompt.section({
      name: 'schedule-core',
      order: 1000,
      text: () => {
        const meta = service.getMeta()
        const week = termWeek(meta.termStart, today())
        const teachingWeek = week === null
          ? '学期起点未配置，教学周未知'
          : `本学期第 ${week} 教学周（起点 ${meta.termStart}）`
        return [
          `日程插件已启用；当前为${teachingWeek}。`,
          '读写用 sched_task / sched_entry（action 选操作），时间为带时区 ISO 8601；冲突可用 allow_conflicts=true 覆盖。',
        ].join('\n')
      },
    }), 'schedule: prompt section')
  }

  ctx.effect(() => registerClientApi(ctx, { service }), 'schedule: client api')
}
