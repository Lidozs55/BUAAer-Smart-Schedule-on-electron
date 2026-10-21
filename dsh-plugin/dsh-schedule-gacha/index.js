/**
 * Host half of @lidozs55/dsh-schedule-gacha.
 *
 * The generic schedule core owns the calendar, entries, conflict detection
 * and settings page. This adapter owns only the six official Bilibili
 * accounts, the announcement parsing rules and the two entries per game
 * (`版本前瞻直播` / `版本更新`). Removing it leaves every existing entry in
 * place; only future refreshes stop.
 */
import { registerGachaApi } from './host/api.js'
import { createGachaService } from './host/service.js'
import { registerGachaTools } from './host/tools.js'

export const inject = ['scheduleCore', 'connection', 'tools']

export async function apply(ctx) {
  const service = createGachaService(ctx, { service: ctx.scheduleCore })

  ctx.effect(() => registerGachaTools(ctx, service), 'gacha-schedule: tools')
  ctx.effect(() => registerGachaApi(ctx, service), 'gacha-schedule: api')
  ctx.effect(() => () => service.dispose(), 'gacha-schedule: dispose')

  // Background refresh is the primary path: no Agent turn is required, and a
  // profile without the optional schedule bundle still gets correct dates.
  // `ctx.timer` is a Cordis context mixin (not a service).
  const timer = ctx.timer
  if (timer !== undefined && timer !== null) {
    ctx.effect(() => timer.timeout(() => {
      if (service.needsRefresh()) void service.requestRefresh()
    }, 20_000), 'gacha-schedule: first refresh')
    ctx.effect(() => timer.interval(() => {
      if (service.needsRefresh()) void service.requestRefresh()
    }, service.autoRefreshMs), 'gacha-schedule: six-hour refresh')
  } else {
    ctx.logger.warn('gacha-schedule: ctx.timer unavailable — automatic refresh disabled')
  }

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt) {
    ctx.effect(() => systemPrompt.section({
      name: 'gacha-schedule',
      order: 1002,
      text: () => [
        '二游前瞻插件已启用：后台每 6 小时从六款游戏的 B 站官方账号刷新版本更新与前瞻直播时间，',
        '每款游戏维护「版本前瞻直播」和「版本更新」两条日程。',
        '用 gacha_schedule 查询（action=list）或立即刷新（action=refresh）；',
        '官方明确给出时间时用 action=apply_official 按游戏写入（带时区 ISO 8601，UTC+8），',
        '不要用 sched_entry 改这些条目，也不要把其他日程改成二游内容。',
        '需要每周由 Agent 核对一次（终末地节奏不固定）时，用 action=watch 登记；',
        '该能力依赖「自动化任务」bundle，缺失时只保留 6 小时后台刷新。',
      ].join('\n'),
    }), 'gacha-schedule: prompt section')
  }

  ctx.logger.info('gacha-schedule: six-game preview tracker active')
}
