import assert from 'node:assert/strict'
import test from 'node:test'
import { createGachaService, planFromApi, toCstIso } from '../host/service.js'
import { GAME_IDS } from '../host/games.js'

// Service-shaped prediction: UTC RFC3339 in, +08:00 plans out. The mapped
// wall clock matches the previous local-planner fixtures
// (update 11-11 06:00–11:00, preview 10-30 19:30–21:00 CST).
const basePrediction = {
  version: '4.7',
  update: {
    utc: '2099-11-10T22:00:00Z', unix_seconds: 4101804000,
    end_utc: '2099-11-11T03:00:00Z',
  },
  preview: {
    utc: '2099-10-30T11:30:00Z', unix_seconds: 4099697400,
    end_utc: '2099-10-30T13:00:00Z',
  },
  update_confidence: 'official',
  preview_confidence: 'inferred',
  update_evidence: '版本结束时间',
  preview_evidence: '更新时间前两周的周五 19:30',
}
const baseView = {
  id: 'hsr', name: '崩坏：星穹铁道', status: 'ok', last_error: '',
  bilibili_space: 'https://space.bilibili.com/1340190821',
  fallback: '/fallback/hsr.svg',
}
const baseNotice = {
  id: 9, game_id: 'hsr', source_type: 'article', external_id: '424242',
  url: 'https://www.bilibili.com/read/cv424242',
  title: '4.6版本「长夜未明」版本更新说明',
  publish_time: { utc: '2099-09-24T04:00:00Z' }, fetched_at: { utc: '2099-10-20T04:00:00Z' },
  is_update_notice: true,
}

function harness({ initialEntries = [], prediction = basePrediction, networkFailure = false } = {}) {
  const rows = new Map(initialEntries.map(row => [row.id, structuredClone(row)]))
  let serial = 0
  let saved = {
    enabled: Object.fromEntries(GAME_IDS.map(id => [id, id === 'hsr'])),
    games: { hsr: { plan: planFromApi({ ...baseView, prediction }), lastRefreshAt: new Date().toISOString() } },
  }
  const writes = []
  const service = {
    getSourceState: () => structuredClone(saved), setSourceState: async (_, value) => { saved = structuredClone(value) },
    listEntries: () => [...rows.values()],
    createEntry: async input => { const row = { ...input, id: `new${++serial}` }; rows.set(row.id, row); writes.push(row); return row },
    updateEntry: async (id, patch) => { const row = { ...rows.get(id), ...patch }; rows.set(id, row); writes.push(row); return row },
    deleteEntry: async ids => { for (const id of Array.isArray(ids) ? ids : [ids]) rows.delete(id) },
  }
  const calls = { games: 0, notices: 0, overrides: 0, deletes: 0 }
  let livePrediction = prediction
  const calendarApi = {
    games: async () => {
      calls.games++
      if (networkFailure) throw new Error('offline')
      return livePrediction === null
        ? [{ ...baseView, status: 'error', last_error: '', prediction: undefined }]
        : [{ ...baseView, prediction: livePrediction }]
    },
    latestNotice: async () => {
      calls.notices++
      if (networkFailure) throw new Error('offline')
      return baseNotice
    },
    posts: async () => ({ data: [baseNotice], pagination: { page: 1, page_size: 20, total: 1, total_pages: 1 } }),
    putOverride: async (gameId, payload) => {
      calls.overrides++
      assert.equal(gameId, 'hsr')
      // Mirror the service behaviour: the correction layers over the rules
      // and missing window ends are filled from the game's usual slot.
      const merged = structuredClone(basePrediction)
      if (payload.update_start) {
        const start = Date.parse(payload.update_start)
        const end = payload.update_end
          ? Date.parse(payload.update_end)
          : start + (Date.parse(basePrediction.update.end_utc) - Date.parse(basePrediction.update.utc))
        merged.update = {
          utc: payload.update_start,
          end_utc: new Date(end).toISOString().replace('.000', ''),
        }
        merged.update_confidence = 'agent'
        merged.update_evidence = payload.note ?? 'Agent 核对官方公告'
      }
      if (payload.preview_start) {
        const start = Date.parse(payload.preview_start)
        const end = payload.preview_end
          ? Date.parse(payload.preview_end)
          : start + (Date.parse(basePrediction.preview.end_utc) - Date.parse(basePrediction.preview.utc))
        merged.preview = {
          utc: payload.preview_start,
          end_utc: new Date(end).toISOString().replace('.000', ''),
        }
        merged.preview_confidence = 'agent'
        merged.preview_evidence = payload.note ?? 'Agent 核对官方公告'
      }
      if (payload.version) merged.version = payload.version
      livePrediction = merged
      return { data: { game: 'hsr' } }
    },
    deleteOverride: async () => {
      calls.deletes++
      livePrediction = basePrediction
      return { data: { game: 'hsr', cleared: true } }
    },
  }
  const ctx = { logger: { info() {}, warn() {} } }
  const adapter = createGachaService(ctx, { service, calendarApi })
  return {
    adapter, rows, writes, calls, api: calendarApi,
    restart: () => createGachaService(ctx, { service, calendarApi }),
    saved: () => saved,
  }
}

const old = (kind, id = kind) => ({ id, title: kind, description: `[gacha:hsr][kind:${kind}]`, start: '2099-10-30T19:30:00+08:00', end: '2099-10-30T21:00:00+08:00', category: 'other' })

test('toCstIso converts UTC service times to explicit +08:00 strings', () => {
  assert.equal(toCstIso('2099-11-10T22:00:00Z'), '2099-11-11T06:00:00+08:00')
  assert.equal(toCstIso('2099-10-31T11:00:00Z'), '2099-10-31T19:00:00+08:00')
  assert.equal(toCstIso('2099-10-31T19:00:00+08:00'), '2099-10-31T19:00:00+08:00')
  assert.equal(toCstIso('not a date'), null)
  assert.equal(toCstIso('2099-10-31T19:00:00'), null)
})

test('planFromApi maps the service prediction onto the plugin plan shape', () => {
  const plan = planFromApi({ ...baseView, prediction: basePrediction })
  assert.equal(plan.version, '4.7')
  assert.equal(plan.updateStart, '2099-11-11T06:00:00+08:00')
  assert.equal(plan.updateEnd, '2099-11-11T11:00:00+08:00')
  assert.equal(plan.previewStart, '2099-10-30T19:30:00+08:00')
  assert.equal(plan.previewEnd, '2099-10-30T21:00:00+08:00')
  assert.equal(plan.updateConfidence, 'official')
  assert.equal(plan.previewConfidence, 'inferred')
  assert.equal(planFromApi({ ...baseView }), null)
  assert.equal(planFromApi({ ...baseView, prediction: { ...basePrediction, update: null, preview: null } }), null)
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
    const article = h.adapter.getPublicGame('hsr').article
    assert.equal(article.url, 'https://www.bilibili.com/read/cv424242')
    assert.equal(article.title, '4.6版本「长夜未明」版本更新说明')
  } finally { h.adapter.dispose() }
})

test('fresh cached startup removes legacy updates, reconciles preview locks and disabled games without fetching', async () => {
  const officialPrediction = { ...basePrediction, preview_confidence: 'official' }
  const disabled = { ...old('preview', 'disabled'), description: '[gacha:genshin][kind:preview]' }
  const foreign = { ...old('update', 'foreign'), description: '私人安排' }
  const h = harness({ prediction: officialPrediction, initialEntries: [old('update'), old('preview'), disabled, foreign] })
  try {
    assert.equal(h.adapter.needsRefresh(), false)
    await h.adapter.reconcileCachedEntries()
    assert.equal(h.calls.games, 0)
    assert.equal(h.rows.has('update'), false); assert.equal(h.rows.has('disabled'), false)
    assert.equal(h.rows.has('foreign'), true)
    const preview = h.rows.get('preview')
    assert.equal(preview.source, 'gacha'); assert.equal(preview.sourceKey, 'hsr:preview')
    assert.equal(preview.lock, true)
    assert.equal(h.saved().games.hsr.entries.update, null)
    assert.equal(h.saved().games.hsr.entries.preview, 'preview')
    const writes = h.writes.length
    await h.adapter.reconcileCachedEntries()
    assert.equal(h.calls.games, 0); assert.equal(h.writes.length, writes)
    assert.equal(h.adapter.needsRefresh(), false)
  } finally { h.adapter.dispose() }
})

test('official preview locks time; update-only confirmation remains source info', async () => {
  const h = harness()
  try {
    const result = await h.adapter.applyOfficial({
      game: 'hsr',
      update_start: '2099-11-11T06:00:00+08:00',
      preview_start: '2099-10-31T19:00:00+08:00',
      note: '官方公告',
    })
    assert.equal(h.calls.overrides, 1)
    assert.equal(h.rows.size, 1)
    const row = [...h.rows.values()][0]
    assert.equal(row.start, '2099-10-31T19:00:00+08:00'); assert.equal(row.lock, true)
    assert.equal(result.plan.updateStart, '2099-11-11T06:00:00+08:00')
    assert.equal(result.plan.previewConfidence, 'agent')
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

test('service outage keeps the previous plan and entries, still clears obsolete update imports', async () => {
  const h = harness({ networkFailure: true, initialEntries: [old('update'), { ...old('preview', 'other'), description: '[gacha:genshin][kind:preview]' }] })
  try {
    await h.adapter.requestRefresh(['hsr'])
    assert.equal(h.rows.has('update'), false); assert.equal(h.rows.has('other'), true)
    assert.ok(h.adapter.getPublicGame('hsr').lastError)
    // The cached plan survives the outage.
    assert.ok(h.adapter.getPublicGame('hsr').plan.previewStart)
  } finally { h.adapter.dispose() }
})

test('duplicate preview imports collapse and clearing the service override unlocks inferred preview', async () => {
  const h = harness({ initialEntries: [old('preview', 'one'), old('preview', 'two')] })
  try {
    await h.adapter.requestRefresh(['hsr'])
    assert.equal(h.rows.size, 1)
    await h.adapter.applyOfficial({ game: 'hsr', preview_start: '2099-10-31T19:00:00+08:00' })
    assert.equal([...h.rows.values()][0].lock, true)
    await h.adapter.clearOverride('hsr')
    assert.equal(h.calls.deletes, 1)
    assert.equal([...h.rows.values()][0].lock, false)
    assert.equal(h.rows.size, 1)
  } finally { h.adapter.dispose() }
})

test('server error surfaces as service_error and never writes a guessed plan', async () => {
  const h = harness()
  const original = h.api.putOverride
  try {
    // Simulate the service rejecting the correction (bad token).
    h.api.putOverride = async () => { throw Object.assign(new Error('需要 Bearer Token'), { name: 'CalendarApiError' }) }
    await assert.rejects(
      h.adapter.applyOfficial({ game: 'hsr', preview_start: '2099-10-31T19:00:00+08:00' }),
      /写入 gacha-calendar 失败/,
    )
  } finally {
    h.api.putOverride = original
    h.adapter.dispose()
  }
})
