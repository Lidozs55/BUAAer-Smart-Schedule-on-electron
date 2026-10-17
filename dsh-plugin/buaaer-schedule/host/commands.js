/**
 * Human commands (§5.3): `/buaaer-sync` reuses a cached SSO jar — the
 * command input is recorded in the session log, so passwords must never
 * ride through here; `/buaaer-import` loads a legacy JSON dump.
 */
import { importLegacyPayload } from './import.js'

/**
 * @param {object} deps - `{ service, startSync }`; `startSync(creds)` from
 *   the sync module adapter in index.js.
 */
export function registerScheduleCommands(ctx, deps) {
  const commands = ctx.get('commands')
  if (!commands) return () => {}
  const fs = ctx.get('fs')
  const disposers = []

  disposers.push(commands.register({
    name: 'buaaer-sync',
    description: '立即同步北航课表（需要本进程内已有登录会话；带密码的同步请在设置页或会话内进行）',
    input: { hint: '' },
    handler: async invocation => {
      const buaaId = deps.service.getMeta().buaaId
      if (!buaaId) {
        return { kind: 'error', text: '尚未配置学号：请先在「日程」插件的设置里填写学号与学期起点。' }
      }
      try {
        const run = deps.startSync({ buaaId })
        const summary = await run.done
        return {
          kind: 'success',
          text: `同步完成：${summary.daysFetched}/7 天，课程规则 ${summary.courses.total} 条（新增 ${summary.courses.created}、更新 ${summary.courses.updated}），考试 ${summary.exams.total} 条（新增 ${summary.exams.created}）。`,
        }
      } catch (error) {
        if (error.code === 'need_login') {
          return { kind: 'error', text: 'SSO 会话未建立或已过期：请在设置页用密码同步一次（约 30 分钟内可免密重跑本命令）。' }
        }
        return { kind: 'error', text: `同步失败：${error.message}` }
      }
    },
  }))

  if (fs) {
    disposers.push(commands.register({
      name: 'buaaer-import',
      description: '从旧版导出的 JSON 文件导入课程/任务/条目（scripts/export-legacy-db.mjs 的产物）',
      input: { hint: '<导出 JSON 的路径>' },
      handler: async invocation => {
        const path = invocation.rawInput.trim()
        if (path === '') {
          return { kind: 'error', text: '用法：/buaaer-import <export-legacy-db.mjs 导出的 JSON 路径>' }
        }
        try {
          const target = await fs.resolve(path, { cwd: invocation.agent?.cwd })
          const text = await fs.readText(target, invocation.signal)
          const counts = await importLegacyPayload(deps.service, JSON.parse(text))
          return {
            kind: 'success',
            text: `导入完成：课程 ${counts.courses.created}/${counts.courses.total}，条目 ${counts.entries.created}/${counts.entries.total}（跳过 ${counts.entries.skipped} 条重复），任务 ${counts.tasks.created}/${counts.tasks.total}（跳过 ${counts.tasks.skipped} 条重复）。`,
          }
        } catch (error) {
          return { kind: 'error', text: `导入失败：${error.message}` }
        }
      },
    }))
  }

  return () => disposers.forEach(dispose => dispose())
}
