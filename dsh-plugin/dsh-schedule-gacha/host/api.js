/**
 * Settings channel of the gacha source adapter. Same browser-trust fence and
 * `{ ok, value } | { ok, error }` shape as the core route, on its own path.
 *
 * The route only exposes the adapter's own state and refresh trigger; every
 * schedule write still happens inside the service through `scheduleCore`.
 */
import { GAME_IDS } from './games.js'

const ROUTE_PATH = '/api/gacha-schedule'
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: JSON_HEADERS,
})
const ok = value => json(200, { ok: true, value })
const fail = (code, message, details) =>
  json(200, { ok: false, error: { code, message, ...(details ? { details } : {}) } })

function operations(service) {
  return {
    setEnabled: async body => {
      if (!GAME_IDS.includes(body.game)) {
        throw Object.assign(new Error(`未知游戏：${body.game}`), { code: 'invalid_input' })
      }
      if (typeof body.enabled !== 'boolean') {
        throw Object.assign(new Error('enabled 必须是布尔值'), { code: 'invalid_input' })
      }
      await service.setEnabled(body.game, body.enabled)
      return service.getPublicState()
    },
    refresh: async body => {
      if (body.game !== undefined && !GAME_IDS.includes(body.game)) {
        throw Object.assign(new Error(`未知游戏：${body.game}`), { code: 'invalid_input' })
      }
      // The refresh runs in the worker queue and is observed through the
      // `refreshing` flag; the HTTP call must not hold the connection for a
      // minute of Bilibili rate limiting.
      if (body.game === undefined) void service.requestRefresh()
      else void service.requestRefresh([body.game])
      return service.getPublicState()
    },
  }
}

export function registerGachaApi(ctx, service) {
  const connection = ctx.get('connection')
  if (!connection) {
    ctx.logger.info('gacha-schedule: connection seam absent — settings channel disabled (tool still works)')
    return () => {}
  }
  const ops = operations(service)

  return connection.fetch.register({
    path: ROUTE_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        if (request.method === 'GET') return ok(service.getPublicState())
        const body = await parseBody(request)
        if (body === undefined) return fail('invalid_json', '请求体不是合法 JSON')
        const operation = ops[body.op]
        if (operation === undefined) return fail('unknown_op', `未知操作：${body.op}`)
        return ok(await operation(body))
      } catch (error) {
        ctx.logger.warn('gacha-schedule api: %s', error.message)
        return fail(error.code ?? 'error', error.message ?? String(error), error.details)
      }
    },
  })
}

async function parseBody(request) {
  const text = await request.text()
  if (text === '') return {}
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}
