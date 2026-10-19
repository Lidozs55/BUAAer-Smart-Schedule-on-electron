/**
 * Client data channel of the BUAA source adapter. It shares the same
 * browser-trust fence as the core's `/api` route but lives on its own path:
 * the source plugin owns only student-id/session state and delegates every
 * schedule write to `scheduleCore`.
 */
import { importLegacyPayload } from './legacy-import.js'
import { SOURCE_ID, saveSourceState } from './state.js'

const ROUTE_PATH = '/api/buaa-schedule'
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: JSON_HEADERS,
})
const ok = value => json(200, { ok: true, value })
const fail = (code, message, details) =>
  json(200, { ok: false, error: { code, message, ...(details ? { details } : {}) } })

const publicState = service => {
  const state = service.getSourceState(SOURCE_ID)
  return { buaaId: state.buaaId ?? '', termCode: state.termCode ?? '' }
}

function operations(service, deps) {
  return {
    setMeta: async body => {
      const patch = body.patch ?? {}
      const current = service.getSourceState(SOURCE_ID)
      const next = { ...current }
      if (patch.buaaId !== undefined) {
        if (typeof patch.buaaId !== 'string') {
          throw Object.assign(new Error('buaaId 必须是字符串'), { code: 'invalid_input' })
        }
        next.buaaId = patch.buaaId.trim()
        // A new student id must not inherit the old id's SSO session.
        if (next.buaaId !== current.buaaId) deps.clearSyncSession?.()
      }
      await saveSourceState(service, next)
      return publicState(service)
    },
    checkSession: () => deps.checkSession(),
    startSync: async body => {
      const run = deps.startSync({
        buaaId: body.buaaId,
        password: body.password,
        ...(body.startDay !== undefined ? { startDay: body.startDay } : {}),
      })
      return run.inline ? { summary: await run.done } : { jobId: run.jobId }
    },
    import: body => importLegacyPayload(service, body.payload),
  }
}

/**
 * Install the route. Caller owns the returned disposer via its effect.
 */
export function registerBuaaApi(ctx, deps) {
  const connection = ctx.get('connection')
  if (!connection) {
    ctx.logger.info('buaa-schedule: connection seam absent — settings channel disabled (tool still works)')
    return () => {}
  }
  const ops = operations(deps.service, deps)

  return connection.fetch.register({
    path: ROUTE_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        if (request.method === 'GET') return ok(publicState(deps.service))
        const body = await parseBody(request)
        if (body === undefined) return fail('invalid_json', '请求体不是合法 JSON')
        const operation = ops[body.op]
        if (operation === undefined) return fail('unknown_op', `未知操作：${body.op}`)
        return ok(await operation(body))
      } catch (error) {
        ctx.logger.warn('buaa-schedule api: %s', error.message)
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
