import assert from 'node:assert/strict'
import test from 'node:test'

import { GAMES } from '../host/games.js'
import {
  extractPreviewAt,
  extractVersionEnd,
  parseAnnouncement,
  parseArticle,
  planNext,
  previewFromVideo,
} from '../host/parse.js'

const game = id => GAMES.find(item => item.id === id)

const HSR = {
  title: '4.6版本「长夜未明」版本更新说明',
  content: [
    '亲爱的开拓者：',
    '■更新时间 2026/09/28 06:00',
    '4.6版本的持续时间为 2026/09/28 4.6版本更新后 - 2026/11/11 06:00。',
  ].join('\n'),
  publishTime: Date.UTC(2026, 8, 24, 4, 0) / 1000,
}

test('崩铁 4.6：更新时间与版本结束时间都来自公告', () => {
  const parsed = parseArticle({ ...HSR, game: game('hsr') })
  assert.equal(parsed.version, '4.6')
  assert.equal(parsed.updateStart, '2026-09-28T06:00:00+08:00')
  assert.equal(parsed.updateEnd, '2026-09-28T11:00:00+08:00')
  assert.equal(parsed.versionEnd, '2026-11-11T06:00:00+08:00')
})

test('崩铁 4.6：下一版本 4.7 = 11/11 更新、10/30 前瞻', () => {
  const current = parseArticle({ ...HSR, game: game('hsr') })
  const plan = planNext({
    game: game('hsr'),
    current,
    now: '2026-10-21T00:00:00+08:00',
  })
  assert.equal(plan.version, '4.7')
  assert.equal(plan.updateStart, '2026-11-11T06:00:00+08:00')
  assert.equal(plan.updateEnd, '2026-11-11T11:00:00+08:00')
  assert.equal(plan.previewStart, '2026-10-30T19:30:00+08:00')
  assert.equal(plan.updateConfidence, 'official')
  assert.equal(plan.previewConfidence, 'inferred')
})

test('原神 7.1：无结束时间时按 42 天节奏推算', () => {
  const current = parseArticle({
    title: '7.1版本更新说明',
    content: '〓更新时间〓\n2026/09/23 06:00\n亲爱的旅行者，7.1版本更新即将开启。',
    publishTime: Date.UTC(2026, 8, 21, 4, 0) / 1000,
    game: game('genshin'),
  })
  assert.equal(current.updateStart, '2026-09-23T06:00:00+08:00')
  assert.equal(current.versionEnd, null)

  const plan = planNext({
    game: game('genshin'),
    current,
    now: '2026-10-21T00:00:00+08:00',
  })
  assert.equal(plan.updateStart, '2026-11-04T06:00:00+08:00')
  assert.equal(plan.previewStart, '2026-10-23T19:30:00+08:00')
  assert.equal(plan.updateConfidence, 'inferred')
})

test('绝区零 3.2：维护结束当天继续滚动到 3.4', () => {
  const current = parseArticle({
    title: '3.2版本「」更新公告',
    content: [
      '【更新开始时间】 2026/09/09 06:00',
      '3.2版本结束时间为2026/10/21 06:00',
    ].join('\n'),
    publishTime: Date.UTC(2026, 8, 4, 4, 0) / 1000,
    game: game('zzz'),
  })
  assert.equal(current.versionEnd, '2026-10-21T06:00:00+08:00')

  const during = planNext({
    game: game('zzz'),
    current,
    now: '2026-10-21T00:00:00+08:00',
  })
  assert.equal(during.version, '3.3')
  assert.equal(during.updateStart, '2026-10-21T06:00:00+08:00')

  const after = planNext({
    game: game('zzz'),
    current,
    now: '2026-10-21T12:00:00+08:00',
  })
  assert.equal(after.version, '3.4')
  assert.equal(after.updateStart, '2026-12-02T06:00:00+08:00')
  assert.equal(after.previewStart, '2026-11-20T19:30:00+08:00')
})

test('绝区零 3.3 实抓摘要（255 字）已含维护时段与版本结束日', () => {
  // 2026-10-21 07:00 发布的 cv53529311 列表摘要，正好被截到 255 字；
  // 说明绝区零不需要拉全文就能得到版本结束日。
  const summary = '亲爱的绳匠： 以下是3.3版本——「重返天空的旅程」的更新与补偿内容。 【更新开始时间】 2026/10/21 06:00（UTC+8） 预计5个小时完成。 【补偿说明】 • 停服更新补偿 补偿内容：菲林*300 补偿对象：2026/10/21 06:00（UTC+8）前绳网等级≥4级的绳匠。 ※领取时间截至3.3版本结束前，3.3版本结束时间为2026/12/02 06:00（UTC+8），该版本共持续42天，请绳匠注意。 • 问题修复补偿 补偿内容：菲林*300 补偿对象：2026/10/21 06:'
  assert.equal(summary.length, 255)

  const current = parseArticle({
    title: '3.3版本「重返天空的旅程」更新公告',
    content: summary,
    publishTime: Date.UTC(2026, 9, 20, 23, 0) / 1000,
    game: game('zzz'),
  })
  assert.equal(current.version, '3.3')
  assert.equal(current.versionName, '重返天空的旅程')
  assert.equal(current.updateStart, '2026-10-21T06:00:00+08:00')
  assert.equal(current.updateEnd, '2026-10-21T11:00:00+08:00')
  assert.equal(current.versionEnd, '2026-12-02T06:00:00+08:00')

  const plan = planNext({
    game: game('zzz'),
    current,
    now: '2026-10-21T07:00:00+08:00',
  })
  assert.equal(plan.version, '3.4')
  assert.equal(plan.updateStart, '2026-12-02T06:00:00+08:00')
  assert.equal(plan.updateEnd, '2026-12-02T11:00:00+08:00')
  assert.equal(plan.previewStart, '2026-11-20T19:30:00+08:00')
  assert.equal(plan.updateConfidence, 'official')
  assert.equal(plan.previewConfidence, 'inferred')
})

test('鸣潮 3.7：维护时段解析', () => {
  const current = parseArticle({
    title: '3.7版本内容说明',
    content: '✦更新维护时间：2026年9月30日04:00 ~ 2026年9月30日11:00（UTC+8）',
    publishTime: Date.UTC(2026, 8, 26, 4, 0) / 1000,
    game: game('wuwa'),
  })
  assert.equal(current.updateStart, '2026-09-30T04:00:00+08:00')
  assert.equal(current.updateEnd, '2026-09-30T11:00:00+08:00')

  const plan = planNext({
    game: game('wuwa'),
    current,
    now: '2026-10-21T00:00:00+08:00',
  })
  assert.equal(plan.updateStart, '2026-11-11T04:00:00+08:00')
  assert.equal(plan.previewStart, '2026-10-30T19:30:00+08:00')
})

test('终末地：公告里的阶段内容更新日优先于 42 天节奏', () => {
  const current = parseArticle({
    title: '「丹青渡」版本更新说明',
    content: [
      '版本更新维护将于 2026/10/15 06:00 - 2026/10/15 12:00（UTC+8）进行。',
      '2026/11/12 12:00 将开启新一期内容更新。',
    ].join('\n'),
    publishTime: Date.UTC(2026, 9, 12, 4, 0) / 1000,
    game: game('endfield'),
  })
  assert.equal(current.updateStart, '2026-10-15T06:00:00+08:00')
  assert.equal(current.phaseUpdate, '2026-11-12T06:00:00+08:00')

  const plan = planNext({
    game: game('endfield'),
    current,
    now: '2026-10-21T00:00:00+08:00',
  })
  assert.equal(plan.updateStart, '2026-11-12T06:00:00+08:00')
  assert.equal(plan.previewStart, '2026-10-30T19:30:00+08:00')
})

test('异环 1.4：无结束时间时按 42 天节奏推算', () => {
  const current = parseArticle({
    title: '1.4版本更新公告',
    content: '9月24日06:00 – 11:00进行版本更新维护',
    publishTime: Date.UTC(2026, 8, 20, 4, 0) / 1000,
    game: game('nte'),
  })
  assert.equal(current.updateStart, '2026-09-24T06:00:00+08:00')
  assert.equal(current.updateEnd, '2026-09-24T11:00:00+08:00')

  const plan = planNext({
    game: game('nte'),
    current,
    now: '2026-10-21T00:00:00+08:00',
  })
  assert.equal(plan.updateStart, '2026-11-05T06:00:00+08:00')
  assert.equal(plan.previewStart, '2026-10-23T19:30:00+08:00')
})

test('HoYo 前瞻视频回推到直播日（上周五 19:30）', () => {
  // 原神 7.1 视频发布于 2026-09-12 21:25（周六），直播是 09-11 周五。
  const preview = previewFromVideo({
    bvid: 'BV1xx',
    title: '《原神》7.1版本前瞻特别节目',
    pubdate: Date.UTC(2026, 8, 12, 13, 25) / 1000,
  }, game('genshin'), '2026-09-23T06:00:00+08:00')
  assert.equal(preview, '2026-09-11T19:30:00+08:00')
})

test('鸣潮/绝区零当日发布的视频回推当天 19:30', () => {
  const zzz = previewFromVideo({
    bvid: 'BV1yy',
    title: '《绝区零》3.3版本前瞻特别节目',
    pubdate: Date.UTC(2026, 9, 9, 12, 20) / 1000,
  }, game('zzz'), '2026-10-21T06:00:00+08:00')
  assert.equal(zzz, '2026-10-09T19:30:00+08:00')
})

test('官方动态里的明确前瞻时间优先于视频与周五规则', () => {
  const current = parseArticle({ ...HSR, game: game('hsr') })
  const plan = planNext({
    game: game('hsr'),
    current,
    now: '2026-10-21T00:00:00+08:00',
    announcements: [{
      text: '4.7版本前瞻特别节目将于10月31日19:00播出，敬请期待。',
      pubdate: Date.UTC(2026, 9, 20, 4, 0) / 1000,
    }],
  })
  assert.equal(plan.previewStart, '2026-10-31T19:00:00+08:00')
  assert.equal(plan.previewConfidence, 'official')
})

test('只写日期的更新公告按该游戏惯例时段补全', () => {
  const parsed = parseAnnouncement({
    text: '4.7版本将于11月11日更新，敬请期待。',
    publishTime: Date.UTC(2026, 9, 20, 4, 0) / 1000,
    game: game('hsr'),
  })
  assert.equal(parsed.update.version, '4.7')
  assert.equal(parsed.update.iso, '2026-11-11T06:00:00+08:00')
})

test('短于两周的“持续时间”不会被当成版本结束时间', () => {
  assert.equal(extractVersionEnd('活动持续时间 2026/10/01 - 2026/10/03。'), null)
})

test('日期解析不依赖宿主时区：总是输出 +08:00', () => {
  const parsed = extractPreviewAt('前瞻直播定档10月30日', Date.UTC(2026, 9, 20, 4, 0) / 1000, game('hsr'))
  assert.equal(parsed, '2026-10-30T19:30:00+08:00')
})

test('视频标题写明播出时间时优先于发布日回推', () => {
  // 周六发布，标题写的是周六 19:30；若按 HoYo「上周五」规则会错回 10-30。
  const preview = previewFromVideo({
    bvid: 'BV1zz',
    title: '《崩坏：星穹铁道》4.7版本前瞻特别节目将于10月31日19:30播出',
    pubdate: Date.UTC(2026, 9, 31, 12, 30) / 1000,
  }, game('hsr'), '2026-11-11T06:00:00+08:00')
  assert.equal(preview, '2026-10-31T19:30:00+08:00')
})

test('合集里只有角色前瞻时不会被当成版本前瞻', () => {
  const current = parseArticle({ ...HSR, game: game('hsr') })
  const plan = planNext({
    game: game('hsr'),
    current,
    now: '2026-10-21T00:00:00+08:00',
    videos: [{
      bvid: 'BV1role',
      title: '《崩坏：星穹铁道》4.7版本角色前瞻',
      pubdate: Date.UTC(2026, 9, 20, 4, 0) / 1000,
    }],
  })
  // 版本号匹配但标题被过滤后，回落到周五规则。
  assert.equal(plan.previewStart, '2026-10-30T19:30:00+08:00')
  assert.equal(plan.previewConfidence, 'inferred')
})
