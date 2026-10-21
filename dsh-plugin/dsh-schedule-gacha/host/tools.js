/**
 * Agent surface of the gacha source adapter.
 *
 * Every write goes through `service.applyOfficial`, which accepts only a game
 * id plus explicit instants. There is deliberately no entry-id parameter:
 * the Agent can correct source update information and its preview entry, and
 * nothing else in the user's schedule.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { GAME_IDS } from './games.js'

const OUTPUT = { type: 'object', additionalProperties: true }

const short = iso => (typeof iso === 'string' ? iso.slice(5, 16).replace('T', ' ') : '—')

const summaryLine = game => {
  const plan = game.plan
  if (!game.enabled) return `${game.name}：已关闭`
  if (plan === null) return `${game.name}：${game.lastError ?? '尚无数据'}`
  const version = plan.version === null ? '' : ` ${plan.version}`
  return `${game.name}${version}：更新 ${short(plan.updateStart)}，前瞻 ${short(plan.previewStart)}`
}

const renderState = value => {
  const enabled = value.games.filter(game => game.enabled).length
  return [
    `已跟踪 ${value.games.length} 款游戏（开启 ${enabled} 款）${value.refreshing ? '，正在刷新…' : ''}`,
    ...value.games.map(summaryLine),
    value.watch.enabled
      ? `周检：每周${['一', '二', '三', '四', '五', '六', '日'][value.watch.weekday - 1]} ${value.watch.time}（${value.watch.timeZone}）由 Agent 核对`
      : '周检：未开启（后台每 6 小时仍会刷新）',
  ].join('\n')
}

const renderRefresh = value => {
  if (Array.isArray(value?.results)) {
    const done = value.results.filter(item => item.status !== undefined)
    const failed = done.filter(item => item.status === 'error')
    return [
      `刷新结束：${done.length} 款${failed.length === 0 ? '成功' : `，${failed.length} 款失败`}`,
      ...done.map(item => `${item.game}：${item.status ?? '—'}${item.error ? `（${item.error}）` : ''}`),
    ].join('\n')
  }
  return renderState(value)
}

const renderApply = value => {
  const plan = value.plan
  if (plan === null) return `${value.name}：没有可写入的时间`
  return `${value.name}：更新 ${short(plan.updateStart)}，前瞻 ${short(plan.previewStart)}（更新仅作来源信息，前瞻同步至日程）`
}

const renderWatch = value => {
  if (value.enabled) {
    return `周检已登记：每周${['一', '二', '三', '四', '五', '六', '日'][value.weekday - 1]} ${value.time}（${value.timeZone}）。`
  }
  return value.reason ?? '周检未开启。'
}

const renderPosts = value => {
  const rows = Array.isArray(value?.data) ? value.data : []
  const pagination = value?.pagination
  const header = pagination
    ? `原始公告 ${pagination.total} 条（第 ${pagination.page}/${pagination.total_pages} 页，时间均为 UTC）`
    : '原始公告'
  const lines = rows.map(row =>
    `${row.game_name}［${row.source_type}］${String(row.title ?? '').slice(0, 60)}`
    + `\n  ${row.publish_time?.utc ?? '—'} ${row.url}`)
  return [header, ...lines].join('\n')
}

export function registerGachaTools(ctx, service) {
  return ctx.tools.register(defineTool({
    name: 'gacha_schedule',
    description: [
      '二游前瞻日程：查询/刷新原神、崩坏：星穹铁道、绝区零、鸣潮、明日方舟：终末地、异环的版本更新与前瞻直播时间，',
      '或核对官方时间：前瞻直播同步至日程，版本更新只保存来源信息。数据来自 gacha-calendar 服务（B 站官方公告采集与推算）。',
      'action=list 查看；refresh 立即刷新；posts 读取服务保存的原始公告/动态；',
      'apply_official 写入官方时间（转发到服务）；watch 开启/关闭每周 Agent 核对。',
    ].join(''),
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'refresh', 'posts', 'apply_official', 'watch'],
        required: true,
        description: 'list 查看 / refresh 刷新 / posts 原始公告 / apply_official 写入官方时间 / watch 周检开关',
      },
      game: {
        type: 'string',
        enum: GAME_IDS,
        description: '游戏 id；refresh/posts/apply_official 使用，refresh 与 posts 省略表示全部',
      },
      page: { type: 'number', description: 'posts 用；页码，默认 1' },
      page_size: { type: 'number', description: 'posts 用；每页条数，默认 20，最大 100' },
      type: {
        type: 'string',
        enum: ['article', 'dynamic', 'video'],
        description: 'posts 用；按来源类型过滤：专栏公告/官方动态/官方视频',
      },
      update_start: {
        type: 'string',
        description: '版本更新开始，带时区 ISO 8601，如 2026-11-11T06:00:00+08:00',
      },
      update_end: {
        type: 'string',
        description: '版本更新维护结束；省略按该游戏惯例时段计算',
      },
      preview_start: {
        type: 'string',
        description: '前瞻直播开始，带时区 ISO 8601，如 2026-10-30T19:30:00+08:00',
      },
      preview_end: {
        type: 'string',
        description: '前瞻直播结束；省略按 21:00 计算',
      },
      version: { type: 'string', description: '版本号，如 4.7' },
      note: { type: 'string', description: '依据摘要，写进日程备注，如「官方动态 10 月 30 日 19:30 前瞻」' },
      clear: { type: 'boolean', description: 'apply_official 时清除此前的 Agent 覆盖，回到公告规则' },
      watch_enabled: { type: 'boolean', description: 'watch 用；默认 true，false 表示取消周检' },
    },
    output: {
      schema: OUTPUT,
      render: (args, value) => {
        switch (args.action) {
          case 'list': return [{ type: 'text', text: renderState(value) }]
          case 'refresh': return [{ type: 'text', text: renderRefresh(value) }]
          case 'posts': return [{ type: 'text', text: renderPosts(value) }]
          case 'apply_official': return [{ type: 'text', text: renderApply(value) }]
          case 'watch': return [{ type: 'text', text: renderWatch(value) }]
          default: return [{ type: 'text', text: '完成' }]
        }
      },
    },
    timeoutMs: 180_000,
    async execute(args, exec) {
      if (exec.signal.aborted) throw new Error('cancelled')
      switch (args.action) {
        case 'list':
          return service.getPublicState()
        case 'refresh':
          return {
            startedAt: new Date().toISOString(),
            results: await service.requestRefresh(
              args.game === undefined ? undefined : [args.game]),
          }
        case 'posts': {
          const page = await service.calendarApi.posts({
            gameId: args.game,
            page: args.page ?? 1,
            pageSize: Math.min(Math.max(args.page_size ?? 20, 1), 100),
            type: args.type,
          })
          return page
        }
        case 'apply_official': {
          if (args.game === undefined) throw new Error('apply_official 需要 game')
          if (args.clear === true) return service.clearOverride(args.game)
          return service.applyOfficial({
            game: args.game,
            update_start: args.update_start,
            update_end: args.update_end,
            preview_start: args.preview_start,
            preview_end: args.preview_end,
            version: args.version,
            note: args.note,
          })
        }
        case 'watch': {
          const sessionId = exec.agent?.session?.id
          if (typeof sessionId !== 'string' || sessionId === '') {
            throw new Error('无法确定当前会话，周检未登记')
          }
          return service.setWatch(sessionId, { enabled: args.watch_enabled !== false })
        }
        default:
          throw new Error(`未知 action：${args.action}`)
      }
    },
  }))
}
