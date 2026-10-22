/**
 * Host half of @lidozs55/dsh-schedule — the generic schedule core.
 *
 * Opens the storage domain, exposes the `scheduleCore` service, then wires
 * the `schedule` CLI (command registry + authenticated loopback server),
 * stateless reminder derivation, a minimal prompt section, and the client
 * `/api` channel. Calendar sources (school portals, export formats) are
 * separate bundles that inject `scheduleCore` and `scheduleCommands` and
 * write through this service; they never share the core's storage handle.
 *
 * No Agent tool schema is registered: low-frequency operations are discovered
 * through `schedule --help` instead of occupying every request's context.
 *
 * Every consumed service is declared here — `ctx.get` is only an immediate
 * lookup, so an undeclared service can be absent at apply time purely by
 * activation order. cordis parks the package until declared providers
 * activate, which is the deterministic contract. The `if (…)` guards below
 * stay as defensive fallbacks, not the primary mechanism.
 */
import Schema from '@deepseek-ai/schemastery'
import { openScheduleDomain } from './host/migrate.js'
import { registerClientApi } from './host/api.js'
import { attachReminders } from './host/reminders.js'
import { createScheduleService } from './host/service.js'
import { createCommandRegistry } from './host/command-registry.js'
import { registerCoreCommands } from './host/commands.js'
import { startScheduleCliServer } from './host/cli-server.js'
import { termWeek, today } from './host/semester.js'

export const inject = ['storageDomain', 'connection', 'systemPrompt']

/** Reminder kill switch and lead times — the core's only Config. */
export const Config = Schema.object({
  remindersEnabled: Schema.boolean().default(true).description('启用提醒（关闭后派生集为空，页面通知与桌宠气泡同步静默）'),
  homeworkLeadMinutes: Schema.number().default(30).description('作业类提醒提前分钟数'),
  examLeadMinutes: Schema.number().default(1440).description('考试类提醒提前分钟数（任务与考试条目同用）'),
  otherLeadMinutes: Schema.number().default(30).description('其他任务提醒提前分钟数'),
  eventLeadMinutes: Schema.number().default(15).description('日程条目提醒提前分钟数（考试类条目改用考试提前量）'),
})

export async function apply(ctx, config) {
  // open() throws loudly on backend/facet/schema mismatch — activation
  // must fail rather than present an empty schedule.
  const domain = await openScheduleDomain(ctx.storageDomain)
  ctx.effect(() => () => { void domain.close() }, 'schedule: domain close')

  const service = createScheduleService(ctx, domain)
  ctx.effect(() => ctx.provide('scheduleCore', service), 'schedule: service')

  // The CLI registry is the one structured command definition used for
  // dispatch, validation and help. Source plugins contribute namespaces here.
  const commands = createCommandRegistry()
  registerCoreCommands(commands, service)
  ctx.effect(() => ctx.provide('scheduleCommands', commands), 'schedule: commands')

  ctx.effect(() => {
    let disposed = false
    let close = () => {}
    void startScheduleCliServer(ctx, commands)
      .then(handle => {
        if (disposed) void handle.dispose()
        else close = handle.dispose
      })
      .catch(error => {
        ctx.logger.warn('schedule-cli: failed to start: %s', error.message)
      })
    return () => {
      disposed = true
      void close()
    }
  }, 'schedule: cli')

  // Stateless reminder derivation (R2): presentation surfaces poll the
  // derived set.
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
          ? `教学周未知（${meta.termStart ? `学期起点 ${meta.termStart}` : '未配置学期起点'}）`
          : `本学期第 ${week} 教学周（起点 ${meta.termStart}）`
        return [
          `日程主插件已启用；当前${teachingWeek}。`,
          '日程、待办的入口是 `schedule` CLI；首次使用先运行 `schedule --help`，操作细则见 schedule skill。',
          '若 `schedule` 不在 PATH，使用宿主在 $DSH_HOME/schedule-cli 生成的启动器（skill 中有具体路径）。',
          '日常操作仅用该 CLI 及其回执，不读取或搜索内部存储、配置或凭据；冲突须经用户确认后才允许重叠。',
        ].join('\n')
      },
    }), 'schedule: prompt section')
  }

  ctx.effect(() => registerClientApi(ctx, { service }), 'schedule: client api')
}
