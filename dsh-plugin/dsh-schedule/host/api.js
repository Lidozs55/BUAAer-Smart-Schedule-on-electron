/**
 * The schedule panel's data channel (decision D-1): exact routes on the
 * shared `/api` Fetch registry. The carrier applies the browser-trust
 * fence and cookie authentication before our handler runs, so these are
 * as trusted as the Remote RPC surface — unlike bare `ctx.webServer`
 * routes, which carry no auth and must never take business writes.
 *
 * Source adapters own their own routes (`/api/<source>`) and call the same
 * `scheduleCore` service; this file is the generic data surface only.
 *
 * Wire shape mirrors `RemoteResult`: `{ ok: true, value } |
 * { ok: false, error: { code, message, details? } }`.
 */
import { importSchedulePayload } from './import.js'

const ROUTE_PATH = '/api/schedule-core'
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' }

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: JSON_HEADERS,
})
const ok = value => json(200, { ok: true, value })
const fail = (code, message, details) =>
  json(200, { ok: false, error: { code, message, ...(details ? { details } : {}) } })

/** POST operations, each mapping to one service method. */
function operations(service) {
  return {
    createEntry: body => service.createEntry(body.input, { allowConflicts: body.allowConflicts }),
    updateEntry: body => service.updateEntry(body.id, body.patch, { allowConflicts: body.allowConflicts }),
    moveEntry: body => service.moveEntry(body.moves, { allowConflicts: body.allowConflicts }),
    deleteEntry: body => service.deleteEntry(body.ids),
    batchCreateEntries: body =>
      service.batchCreateEntries(body.inputs, { allowConflicts: body.allowConflicts }),
    createTask: body => service.createTask(body.input),
    updateTask: body => service.updateTask(body.id, body.patch),
    setTaskCompleted: body => service.setTaskCompleted(body.id, body.completed),
    deleteTask: body => service.deleteTask(body.id),
    clearAllData: () => service.clearAllData(),
    setMeta: body => service.setMeta(body.patch),
    setCategories: body => service.setCategories(body.categories),
    /** Full-domain dump — the importable counterpart of the settings export. */
    export: () => ({
      global: service.getMeta(),
      entries: service.listEntries(),
      tasks: service.listTasks(),
    }),
    import: body => importSchedulePayload(service, body.payload),
  }
}

/**
 * Install the routes. Caller owns the returned disposer via its effect.
 * @param {object} deps - `{ service }`.
 */
export function registerClientApi(ctx, deps) {
  const connection = ctx.get('connection')
  if (!connection) {
    ctx.logger.info('schedule-core: connection seam absent — client panel data channel disabled (tools still work)')
    return () => {}
  }
  const ops = operations(deps.service)

  return connection.fetch.register({
    path: ROUTE_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const url = new URL(request.url)
        if (request.method === 'GET') {
          // Reminder moments for the client notification poller. The set is
          // derived fresh each call; the client dedups by `key` + `at`.
          if (url.searchParams.get('view') === 'reminders') {
            return ok(deps.service.upcomingReminders())
          }
          // Reject malformed weekStart (e.g. the string 'undefined') instead
          // of letting it poison the snapshot (docs/10 P7).
          const raw = url.searchParams.get('weekStart')
          const weekStart = raw !== null && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined
          return ok(deps.service.snapshot({ weekStart }))
        }
        const body = await parseBody(request)
        if (body === undefined) {
          return fail('invalid_json', '请求体不是合法 JSON')
        }
        const operation = ops[body.op]
        if (operation === undefined) {
          return fail('unknown_op', `未知操作：${body.op}`)
        }
        return ok(await operation(body))
      } catch (error) {
        const details = error.details === undefined ? undefined : { details: error.details }
        ctx.logger.warn('schedule-core api: %s %o', error.message, details ?? {})
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
