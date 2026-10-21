/**
 * Client data channel of the BUAA source adapter. It shares the same
 * browser-trust fence as the core's `/api` route but lives on its own path:
 * the source plugin owns only the student id and the sync call, and
 * delegates every schedule write to `scheduleCore`.
 *
 * The term anchor is NOT writable here: the core's settings page already
 * owns it (the source adapter uses it to project teaching weeks onto dates), so this card
 * only reports which term that anchor currently resolves to.
 */
import { SOURCE_ID } from './state.js'
import { termCodeFor, termLabel } from './time.js'

const ROUTE_PATH = '/api/buaa-schedule'
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: JSON_HEADERS,
})
const ok = value => json(200, { ok: true, value })
const fail = (code, message, details) =>
  json(200, { ok: false, error: { code, message, ...(details ? { details } : {}) } })

const trimId = value => (typeof value === 'string' ? value.trim() : '')

/** What the settings card renders: stored student id, plus the resolved term. */
const publicState = service => {
  const state = service.getSourceState(SOURCE_ID)
  const termStart = service.getMeta().termStart
  const termCode = termStart === '' ? '' : termCodeFor(termStart)
  return {
    buaaId: typeof state.buaaId === 'string' ? state.buaaId : '',
    termStart,
    termCode,
    termLabel: termCode === '' ? '' : termLabel(termCode),
  }
}

function operations(service, deps) {
  return {
    setStudentId: async body => {
      if (typeof body.buaaId !== 'string') {
        throw Object.assign(new Error('学号必须是字符串'), { code: 'invalid_input' })
      }
      await service.setSourceState(SOURCE_ID, {
        ...service.getSourceState(SOURCE_ID),
        buaaId: trimId(body.buaaId),
      })
      return publicState(service)
    },
    sync: async body => deps.runSync({
      buaaId: trimId(body.buaaId),
      password: body.password,
    }),
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