import assert from 'node:assert/strict'
import test from 'node:test'
import { createGachaService } from '../host/service.js'
import { planNext } from '../host/parse.js'
import { GAME_IDS, getGame } from '../host/games.js'

const game = getGame('hsr')
const current = { version: '4.6', updateStart: '2099-09-28T06:00:00+08:00', updateEnd: '2099-09-28T11:00:00+08:00', versionEnd: '2099-11-11T06:00:00+08:00', previewAt: null, phaseUpdate: null }
const published = Date.parse('2099-10-20T12:00:00+08:00') / 1000
const plan = overrides => planNext({ game, current, now: '2099-10-21T00:00:00+08:00', ...overrides })

function harness({ initialEntries = [], currentPlan = plan({}), networkFailure = false } = {}) {
  const rows = new Map(initialEntries.map(row => [row.id, structuredClone(row)]))
  let serial = 0
  let saved = { enabled: Object.fromEntries(GAME_IDS.map(id => [id, id === 'hsr'])), games: { hsr: { current, plan: currentPlan, officialPlan: currentPlan, lastRefreshAt: new Date().toISOString() } } }
  const writes = []
  const service = {
    getSourceState: () => structuredClone(saved), setSourceState: async (_, value) => { saved = structuredClone(value) },
    listEntries: () => [...rows.values()],
    createEntry: async input => { const row = { ...input, id: `new${++serial}` }; rows.set(row.id, row); writes.push(row); return row },
    updateEntry: async (id, patch) => { const row = { ...rows.get(id), ...patch }; rows.set(id, row); writes.push(row); return row },
    deleteEntry: async ids => { for (const id of Array.isArray(ids) ? ids : [ids]) rows.delete(id) },
  }
  const fetches = { count: 0 }
  const feed = async () => { fetches.count++; if (networkFailure) throw new Error('offline'); return [] }
  const bilibili = { articleList: feed, featureVideos: feed, searchVideos: feed, dynamics: feed }
  const ctx = { logger: { info() {}, warn() {} } }
  const adapter = createGachaService(ctx, { service, bilibili })
  return { adapter, rows, writes, fetches, restart: () => createGachaService(ctx, { service, bilibili }), saved: () => saved }
}

const old = (kind, id = kind) => ({ id, title: kind, description: `[gacha:hsr][kind:${kind}]`, start: '2099-10-30T19:30:00+08:00', end: '2099-10-30T21:00:00+08:00', category: 'other' })

test('video back-projection and date-only announcements remain inferred; only explicit datetime is official', () => {
  const videos = [{ title: '4.7版本前瞻特别节目', bvid: 'BV-replay', pubdate: published }]
  assert.equal(plan({ videos }).previewConfidence, 'inferred')
  assert.match(plan({ videos }).previewEvidence, /非确认时间/)
  assert.equal(plan({ announcements: [{ text: '4.7版本前瞻定档10月30日', pubdate: published }] }).previewConfidence, 'inferred')
  assert.equal(plan({ videos: [{ ...videos[0], title: '4.7版本前瞻将于10月31日19:00播出' }] }).previewConfidence, 'official')
  assert.equal(plan({ announcements: [{ text: '4.7版本前瞻将于10月31日19:00播出', pubdate: published }] }).previewConfidence, 'official')
})

test('refresh writes inferred preview into core entries, never UPDATE, removes old imported updates only', async () => {
  const h = harness({ initialEntries: [old('update'), { ...old('update', 'foreign'), description: 'manual version update' }] })
  try {
    await h.adapter.requestRefresh(['hsr'])
    assert.equal(h.rows.has('update'), false); assert.equal(h.rows.has('foreign'), true)
    const previews = [...h.rows.values()].filter(row => row.source === 'gacha')
    assert.equal(previews.length, 1)
    assert.equal(previews[0].sourceKey, 'hsr:preview'); assert.equal(previews[0].lock, false)
    assert.match(previews[0].title, /版本前瞻直播/)
    assert.ok(h.adapter.getPublicGame('hsr').plan.updateStart)
    assert.equal(h.adapter.getPublicGame('hsr').entries.update, null)
  } finally { h.adapter.dispose() }
})

test('fresh cached startup removes legacy updates, reconciles preview locks and disabled games without fetching', async () => {
  const official = { ...plan({}), previewConfidence: 'official' }
  const disabled = { ...old('preview', 'disabled'), description: '[gacha:genshin][kind:preview]' }
  const foreign = { ...old('update', 'foreign'), description: '私人安排' }
  const h = harness({ currentPlan: official, initialEntries: [old('update'), old('preview'), disabled, foreign] })
  try {
    assert.equal(h.adapter.needsRefresh(), false)
    await h.adapter.reconcileCachedEntries()
    assert.equal(h.fetches.count, 0)
    assert.equal(h.rows.has('update'), false); assert.equal(h.rows.has('disabled'), false)
    assert.equal(h.rows.has('foreign'), true)
    const preview = h.rows.get('preview')
    assert.equal(preview.source, 'gacha'); assert.equal(preview.sourceKey, 'hsr:preview')
    assert.equal(preview.lock, true)
    assert.equal(h.saved().games.hsr.entries.update, null)
    assert.equal(h.saved().games.hsr.entries.preview, 'preview')
    const writes = h.writes.length
    await h.adapter.reconcileCachedEntries()
    assert.equal(h.fetches.count, 0); assert.equal(h.writes.length, writes)
    assert.equal(h.adapter.needsRefresh(), false)
  } finally { h.adapter.dispose() }
})

test('official preview locks time; update-only confirmation remains source info', async () => {
  const h = harness()
  try {
    const result = await h.adapter.applyOfficial({ game: 'hsr', update_start: '2099-11-11T06:00:00+08:00', preview_start: '2099-10-31T19:00:00+08:00', note: '官方公告' })
    assert.equal(h.rows.size, 1)
    const row = [...h.rows.values()][0]
    assert.equal(row.start, '2099-10-31T19:00:00+08:00'); assert.equal(row.lock, true)
    assert.equal(result.plan.updateStart, '2099-11-11T06:00:00+08:00')
    assert.equal(result.entries.update, null)
    await assert.rejects(h.adapter.applyOfficial({ game: 'hsr', preview_start: '2099-10-31T19:00:00' }), /带时区/)
  } finally { h.adapter.dispose() }
})

test('refresh preserves inferred user time and all editable fields, including after restart; official replaces only timing', async () => {
  const h = harness()
  let restarted
  try {
    await h.adapter.requestRefresh(['hsr'])
    const row = [...h.rows.values()][0]
    const edited = { ...row, title: '一起看直播', description: '我的备注（移除所有来源标记）', location: '宿舍', category: 'meeting', start: '2099-10-31T20:00:00+08:00', end: '2099-10-31T22:00:00+08:00' }
    h.rows.set(row.id, edited)
    h.adapter.dispose(); restarted = h.restart()
    await restarted.requestRefresh(['hsr'])
    assert.deepEqual(h.rows.get(row.id), edited)
    await restarted.applyOfficial({ game: 'hsr', preview_start: '2099-11-01T19:00:00+08:00' })
    const confirmed = h.rows.get(row.id)
    assert.equal(confirmed.start, '2099-11-01T19:00:00+08:00'); assert.equal(confirmed.lock, true)
    for (const key of ['title', 'description', 'location', 'category']) assert.equal(confirmed[key], edited[key])
    await restarted.setEnabled('hsr', false)
    assert.equal(h.rows.size, 0)
  } finally { h.adapter.dispose(); restarted?.dispose() }
})

test('refresh with no usable plan still clears obsolete update imports and never touches other games', async () => {
  const h = harness({ currentPlan: null, networkFailure: true, initialEntries: [old('update'), { ...old('preview', 'other'), description: '[gacha:genshin][kind:preview]' }] })
  // Cached current facts can still form an inferred preview despite a feed failure.
  try {
    await h.adapter.requestRefresh(['hsr'])
    assert.equal(h.rows.has('update'), false); assert.equal(h.rows.has('other'), true)
    assert.ok(h.adapter.getPublicGame('hsr').lastError)
  } finally { h.adapter.dispose() }
})

test('cached explicit preview survives all feed failures without unlocking or moving; old updates still clear', async () => {
  const official = { ...plan({}), previewStart: '2099-10-31T19:00:00+08:00', previewEnd: '2099-10-31T21:00:00+08:00', previewConfidence: 'official', previewEvidence: '官方前瞻公告（明确日期与时间）' }
  const h = harness({ currentPlan: official, networkFailure: true, initialEntries: [old('update'), { ...old('preview'), source: 'gacha', sourceKey: 'hsr:preview', start: official.previewStart, end: official.previewEnd, lock: true }] })
  try {
    await h.adapter.requestRefresh(['hsr'])
    const preview = [...h.rows.values()].find(row => row.sourceKey === 'hsr:preview')
    assert.equal(preview.lock, true); assert.equal(preview.start, official.previewStart)
    assert.equal(h.adapter.getPublicGame('hsr').plan.previewConfidence, 'official')
    assert.equal(h.rows.has('update'), false)
  } finally { h.adapter.dispose() }
})

test('duplicate preview imports collapse and clearing official evidence unlocks inferred preview', async () => {
  const h = harness({ initialEntries: [old('preview', 'one'), old('preview', 'two')] })
  try {
    await h.adapter.requestRefresh(['hsr'])
    assert.equal(h.rows.size, 1)
    await h.adapter.applyOfficial({ game: 'hsr', preview_start: '2099-10-31T19:00:00+08:00' })
    assert.equal([...h.rows.values()][0].lock, true)
    await h.adapter.clearOverride('hsr')
    assert.equal([...h.rows.values()][0].lock, false)
    assert.equal(h.rows.size, 1)
  } finally { h.adapter.dispose() }
})
