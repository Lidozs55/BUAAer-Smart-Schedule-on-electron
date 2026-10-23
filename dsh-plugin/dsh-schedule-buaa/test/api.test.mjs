import assert from 'node:assert/strict'
import test from 'node:test'
import { registerBuaaApi } from '../host/api.js'

function harness(entries = []) {
  const routes = []
  const ctx = {
    get: name => name === 'connection'
      ? { fetch: { register: route => { routes.push(route); return () => {} } } }
      : undefined,
    logger: { warn() {} },
  }
  let state = { buaaId: '23370001', signinError: '' }
  const service = {
    getMeta: () => ({ termStart: '2026-09-07' }),
    getSourceState: () => state,
    setSourceState: async (_source, next) => { state = next },
    listEntries: () => entries,
  }
  const calls = []
  const signin = {
    sessionSnapshot: () => ({ username: '23370001', lastUsedAt: '2026-10-22T00:00:00.000Z' }),
    signinEntry: async entry => {
      calls.push(entry)
      return { success: true, message: '签到成功', status: 1 }
    },
  }
  const deps = { service, signin, spoc: null, runSync: async () => ({}) }
  const dispose = registerBuaaApi(ctx, deps)
  return { routes, calls, dispose, deps }
}

const post = async (route, body) => {
  const response = await route.fetch(new Request('http://localhost/api/buaa-schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))
  return response.json()
}

test('BUAA API exposes memory-only sign-in facts on GET', async () => {
  const app = harness()
  const response = await app.routes[0].fetch(new Request('http://localhost/api/buaa-schedule'))
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.value.signinSession, {
    username: '23370001', lastUsedAt: '2026-10-22T00:00:00.000Z',
  })
  assert.equal(body.value.signinError, '')
  assert.equal(JSON.stringify(body).includes('sessionId'), false)
  app.dispose()
})

test('sign-in operation resolves the stored BUAA teaching entry host-side', async () => {
  const entry = {
    id: 'e1', source: 'buaa', sourceKey: 'teaching:软件工程:2026-10-22:08:00',
    title: '软件工程', start: '2026-10-22T08:00:00+08:00', end: '2026-10-22T09:40:00+08:00',
  }
  const app = harness([entry])
  const body = await post(app.routes[0], { op: 'signin', entryId: 'e1' })
  assert.equal(body.ok, true)
  assert.equal(body.value.message, '签到成功')
  assert.equal(app.calls.length, 1)
  assert.equal(app.calls[0], entry)

  const missing = await post(app.routes[0], { op: 'signin', entryId: 'absent' })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'not_found')
  app.dispose()
})

test('sign-in operation refuses non-teaching and non-BUAA entries', async () => {
  const exam = { id: 'x1', source: 'buaa', sourceKey: 'exam:math\u00002026-11-10', title: '数学 考试' }
  const foreign = { id: 'm1', source: 'manual', sourceKey: 'teaching:math', title: '数学' }
  const app = harness([exam, foreign])

  for (const entryId of ['x1', 'm1']) {
    const body = await post(app.routes[0], { op: 'signin', entryId })
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'invalid_input')
  }
  assert.equal(app.calls.length, 0)
  app.dispose()
})

test('editing the account invalidates both memory sessions, but a no-op edit does not', async () => {
  const app = harness()
  const cleared = []
  app.deps.spoc = { clearSession: () => cleared.push('spoc') }
  app.deps.signin.clearSession = () => cleared.push('signin')
  const route = app.routes[0]
  assert.equal((await post(route, { op: 'setStudentId', buaaId: '23370001' })).ok, true)
  assert.deepEqual(cleared, [])
  assert.equal((await post(route, { op: 'setStudentId', buaaId: 'student-b' })).ok, true)
  assert.deepEqual(cleared, ['spoc', 'signin'])
  assert.equal(app.deps.service.getSourceState().buaaId, 'student-b')
})

test('account edits are rejected during sync and sign-in refuses a mismatched account', async () => {
  const app = harness([{ id: 'e1', source: 'buaa', sourceKey: 'teaching:math' }])
  app.deps.isSyncing = () => true
  const edit = await post(app.routes[0], { op: 'setStudentId', buaaId: 'student-b' })
  assert.equal(edit.error.code, 'busy')
  assert.equal(app.deps.service.getSourceState().buaaId, '23370001')
  app.deps.signin.sessionSnapshot = () => ({ username: 'student-b' })
  const signin = await post(app.routes[0], { op: 'signin', entryId: 'e1' })
  assert.equal(signin.error.code, 'auth')
  assert.equal(app.calls.length, 0)
})
