/**
 * Host half of @buaaer/dsh-schedule-buaa — the BUAA JW source adapter.
 *
 * Hard dependency: `scheduleCore` (the generic schedule core). This bundle
 * owns BUAA-specific state (student id, SSO session) and writes courses and
 * exam tasks through the core service. Removing it leaves the core and its
 * data untouched; adding another school/format follows the same pattern.
 *
 * `connection` and `tools` are required because the settings channel and
 * Agent tool are core parts of this adapter. `commands` / `systemPrompt` /
 * `fs` are optional seams read with `ctx.get`.
 */
import { registerBuaaApi } from './host/api.js'
import { registerBuaaCommands } from './host/commands.js'
import { checkSyncSession, clearSyncSession, startSyncJob } from './host/sync.js'
import { registerBuaaTools } from './host/tools.js'

export const inject = ['scheduleCore', 'connection', 'tools']

export async function apply(ctx) {
  const service = ctx.scheduleCore

  const startSync = creds => startSyncJob({ service, ctx }, creds)
  const checkSession = () => checkSyncSession({ service })
  const deps = { service, startSync, checkSession, clearSyncSession }

  ctx.effect(() => registerBuaaTools(ctx, deps), 'buaa-schedule: tools')
  ctx.effect(() => registerBuaaApi(ctx, deps), 'buaa-schedule: api')
  ctx.effect(() => registerBuaaCommands(ctx, deps), 'buaa-schedule: commands')

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt) {
    ctx.effect(() => systemPrompt.section({
      name: 'buaa-schedule',
      order: 1001,
      text: () => [
        '北航教务导入插件已启用：课程表和考试任务可通过 buaa_course_sync 工具同步。',
        '同步需要用户提供北航统一认证密码（仅当次使用、不保存）；已有 30 分钟内缓存会话时可用 /buaa-sync 免密重跑。',
        '学号、学期码等来源状态由该插件独立保存；学期起点在日程设置里维护。',
      ].join('\n'),
    }), 'buaa-schedule: prompt section')
  }

  ctx.logger.info('buaa-schedule: BUAA source adapter active')
}
