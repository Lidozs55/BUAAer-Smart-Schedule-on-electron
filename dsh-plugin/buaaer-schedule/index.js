/**
 * Host half of @buaaer/dsh-schedule: opens the storage domain, exposes the
 * `buaaerSchedule` service, then wires tools, the reminder-mirroring
 * subsystem, prompt section, commands, the client `/api` channel, and the
 * BUAA sync job. Optional seams are read with `ctx.get` so a leaner
 * profile degrades quietly instead of failing activation.
 */
import Schema from '@deepseek-ai/schemastery'
import { registerScheduleCommands } from './host/commands.js'
import { scheduleDomainSpec } from './host/domain.js'
import { registerClientApi } from './host/api.js'
import { attachReminders } from './host/reminders.js'
import { createScheduleService } from './host/service.js'
import { registerScheduleTools } from './host/tools.js'
import { startSyncJob } from './host/sync.js'
import { termWeek, today } from './host/semester.js'

export const inject = ['storageDomain', 'tools']

/** Reminder kill switch and lead times — the plugin's only Config. */
export const Config = Schema.object({
  remindersEnabled: Schema.boolean().default(true).description('启用截止提醒（需宿主「自动化任务」bundle）'),
  homeworkLeadMinutes: Schema.number().default(30).description('作业类提醒提前分钟数'),
  examLeadMinutes: Schema.number().default(1440).description('考试类提醒提前分钟数'),
  otherLeadMinutes: Schema.number().default(30).description('其他任务提醒提前分钟数'),
})

export async function apply(ctx, config) {
  // open() throws loudly on backend/facet/schema mismatch — activation
  // must fail rather than present an empty schedule.
  const domain = await ctx.storageDomain.open(scheduleDomainSpec)
  ctx.effect(() => () => { void domain.close() }, 'buaaer: domain close')

  const service = createScheduleService(ctx, domain)
  ctx.effect(() => ctx.provide('buaaerSchedule', service), 'buaaer: service')

  ctx.effect(() => registerScheduleTools(ctx, service, { service, ctx }), 'buaaer: tools')

  // Optional reminder mirroring (R2): owns its effect and degrades quietly.
  attachReminders(ctx, service, config)

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt) {
    ctx.effect(() => systemPrompt.section({
      name: 'buaaer-schedule',
      order: 1000,
      text: () => {
        const meta = service.getMeta()
        const week = termWeek(meta.termStart, today())
        const teachingWeek = week === null
          ? '学期起点未配置，教学周未知'
          : `本学期第 ${week} 教学周（起点 ${meta.termStart}）`
        return [
          '用户使用 BUAAer 日程插件管理课程表、任务截止与日历条目。',
          `当前为${teachingWeek}。课程按「第 1-16 周」式周期规则存储，查询某周课程用 buaaer_entry_list 的 week_start 现算。`,
          '修改任务/条目一律走 buaaer_* 工具；时间参数必须是带时区的 ISO 8601（如 2026-10-19T08:00:00+08:00）。',
          '重叠冲突会返回原因，确认覆盖时带 allow_conflicts=true 重试。',
        ].join('\n')
      },
    }), 'buaaer: prompt section')
  }

  const startSync = creds => startSyncJob({ service, ctx }, creds)
  ctx.effect(() => registerScheduleCommands(ctx, { service, startSync }), 'buaaer: commands')
  ctx.effect(() => registerClientApi(ctx, { service, startSync }), 'buaaer: client api')
}
