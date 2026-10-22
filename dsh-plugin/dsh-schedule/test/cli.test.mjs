import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import test from 'node:test'
import { createCommandRegistry } from '../host/command-registry.js'
import { registerCoreCommands } from '../host/commands.js'
import { startScheduleCliServer } from '../host/cli-server.js'
import { createScheduleService } from '../host/service.js'

function memoryService() {
  const maps = { entries: new Map(), tasks: new Map() }
  let global = { termStart: '2026-09-07', sourceState: {}, entryModelVersion: 2 }
  return createScheduleService({ logger: { warn() {} } }, {
    global: { get: () => global, set: async value => { global = value } },
    table: name => ({
      get: id => maps[name].get(id),
      entries: () => maps[name].entries(),
      put: async (id, row) => { maps[name].set(id, row) },
      delete: async id => maps[name].delete(id),
    }),
  })
}

async function start() {
  const directory = mkdtempSync(join(tmpdir(), 'schedule-cli-test-'))
  const registry = createCommandRegistry()
  const service = memoryService()
  registerCoreCommands(registry, service)
  registry.register({
    name: 'sample',
    summary: 'test-only namespace',
    commands: [{
      name: 'secret',
      summary: 'checks stdin password injection',
      options: {
        password: { type: 'string', hidden: true, description: 'injected' },
      },
      run: input => ({ passwordLength: input.password?.length ?? 0 }),
    }],
  })
  registry.registerGuide({
    name: 'sample',
    title: 'Sample guide',
    summary: 'test guide',
    body: 'sample guide body',
  })
  const server = await startScheduleCliServer({ logger: { info() {}, warn() {} } }, registry, { directory })
  const cli = join(directory, 'schedule.js')
  // Async spawn is required: the test process also hosts the HTTP server, so
  // a synchronous child would block the event loop and deadlock the request.
  const run = (args, input) => new Promise(resolve => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, SCHEDULE_CLI_HOME: directory },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', status => resolve({ status: status ?? 1, stdout, stderr }))
    child.stdin.end(input)
  })
  return { directory, server, service, run, cli }
}

const json = result => {
  assert.equal(result.stderr, '')
  return JSON.parse(result.stdout)
}

test('CLI discovers commands and guides, then executes a write and list', async () => {
  const { directory, server, run } = await start()
  try {
    assert.ok((process.env.PATH ?? '').split(delimiter).includes(directory))
    const cmdLauncher = readFileSync(join(directory, 'schedule.cmd'), 'utf8')
    assert.match(cmdLauncher, /ELECTRON_RUN_AS_NODE=1/)
    assert.ok(cmdLauncher.includes(process.execPath.replace(/%/g, '%%')))
    assert.match(readFileSync(join(directory, 'schedule'), 'utf8'), /ELECTRON_RUN_AS_NODE=1/)

    const help = await run(['--help'])
    assert.equal(help.status, 0)
    assert.match(help.stdout, /entry/)
    assert.match(help.stdout, /task/)
    assert.match(help.stdout, /sample/)
    assert.match(help.stdout, /workflow/)
    assert.match(help.stdout, /guide/)

    const bare = await run([])
    assert.equal(bare.status, 0)
    assert.match(bare.stdout, /entry/)
    assert.match(bare.stdout, /guide/)

    const leaf = await run(['entry', 'create', '--help'])
    assert.equal(leaf.status, 0)
    assert.match(leaf.stdout, /--allow-conflicts/)
    assert.match(leaf.stdout, /--input/)

    const created = await run([
      'entry', 'create',
      '--title', '编译器构造',
      '--start', '2026-10-24T14:00:00+08:00',
      '--end', '2026-10-24T16:00:00+08:00',
      '--category', 'course',
      '--location', '主103',
      '--remind-lead', '60',
    ])
    assert.equal(created.status, 0)
    const receipt = json(created)
    assert.equal(receipt.ok, true)
    assert.equal(receipt.command, 'entry.create')
    assert.equal(receipt.value.title, '编译器构造')
    assert.equal(receipt.value.week, 7)
    assert.equal(receipt.value.remindLead, 60)
    assert.equal(typeof receipt.value.id, 'string')

    const cleared = await run(['entry', 'update', '--id', receipt.value.id, '--remind-lead', '-1'])
    assert.equal(cleared.status, 0)
    assert.equal(json(cleared).value.remindLead, null)

    const listed = json(await run(['entry', 'list', '--from', '2026-10-24T00:00:00+08:00', '--to', '2026-10-25T00:00:00+08:00']))
    assert.equal(listed.ok, true)
    assert.equal(listed.value.count, 1)
    assert.equal(listed.value.entries[0].id, receipt.value.id)
  } finally {
    await server.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('CLI returns structured conflict receipts and rejects bad usage', async () => {
  const { directory, server, run } = await start()
  try {
    assert.equal((await run(['entry', 'create', '--title', 'A', '--start', '2026-10-24T10:00:00+08:00', '--end', '2026-10-24T11:00:00+08:00'])).status, 0)
    const conflict = await run(['entry', 'create', '--title', 'B', '--start', '2026-10-24T10:30:00+08:00', '--end', '2026-10-24T11:30:00+08:00'])
    assert.equal(conflict.status, 1)
    const receipt = json(conflict)
    assert.equal(receipt.ok, false)
    assert.equal(receipt.error.code, 'conflict')
    assert.ok(receipt.error.details.conflicts.length > 0)

    const bad = await run(['entry', 'create', '--title', 'C'])
    assert.equal(bad.status, 2)
    assert.match(bad.stdout, /start/)

    const unknown = await run(['entry', 'create', '--title', 'C', '--start', '2026-10-24', '--nope', 'x'])
    assert.equal(unknown.status, 2)
    assert.match(unknown.stdout, /nope/)
  } finally {
    await server.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('batch input can come from stdin without putting JSON in argv', async () => {
  const { directory, server, run } = await start()
  try {
    const batch = await run(['entry', 'batch-create', '--input', '-'], JSON.stringify([
      { title: '批量 A', start: '2026-10-24T08:00:00+08:00', end: '2026-10-24T09:00:00+08:00' },
      { title: '批量 B', start: '2026-10-24T09:00:00+08:00', end: '2026-10-24T10:00:00+08:00' },
    ]))
    assert.equal(batch.status, 0)
    const receipt = json(batch)
    assert.equal(receipt.value.okCount, 2)
    assert.equal(receipt.value.total, 2)
    assert.ok(receipt.value.results.every(item => item.ok && item.entry.id))
  } finally {
    await server.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('password is supplied via stdin, never argv, and the guide renders', async () => {
  const { directory, server, run } = await start()
  try {
    const secret = await run(['sample', 'secret', '--password-stdin'], 'top-secret\n')
    assert.equal(secret.status, 0)
    assert.deepEqual(json(secret).value, { passwordLength: 10 })
    assert.equal(secret.stdout.includes('top-secret'), false)

    const direct = await run(['sample', 'secret', '--password', 'top-secret'])
    assert.equal(direct.status, 2)
    assert.equal(direct.stdout.includes('top-secret'), false)
    assert.equal(JSON.parse(direct.stdout).error.code, 'usage')

    const guide = await run(['guide', 'sample'])
    assert.equal(guide.status, 0)
    assert.match(guide.stdout, /Sample guide/)
    assert.match(guide.stdout, /sample guide body/)

    const guideViaHelp = await run(['help', 'guide', 'sample'])
    assert.equal(guideViaHelp.status, 0)
    assert.match(guideViaHelp.stdout, /sample guide body/)
  } finally {
    await server.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('loopback server rejects missing tokens, foreign Host headers and malformed bodies', async () => {
  const { directory, server } = await start()
  try {
    const descriptor = JSON.parse(readFileSync(join(directory, 'current.json'), 'utf8'))
    const call = (headers, { method = 'GET', path = '/v1/catalog', body } = {}) => new Promise((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: descriptor.port,
        path,
        method,
        headers,
      }, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
      })
      req.on('error', reject)
      req.end(body)
    })
    const missing = await call({ Host: `127.0.0.1:${descriptor.port}` })
    assert.equal(missing.status, 401)
    assert.equal(missing.body.error.code, 'unauthorized')
    const foreign = await call({
      Host: 'attacker.example',
      Authorization: `Bearer ${descriptor.token}`,
    })
    assert.equal(foreign.status, 403)
    assert.equal(foreign.body.error.code, 'forbidden_host')
    const malformed = await call({
      Host: `127.0.0.1:${descriptor.port}`,
      Authorization: `Bearer ${descriptor.token}`,
      'Content-Type': 'application/json',
    }, { method: 'POST', path: '/v1/execute', body: '{' })
    assert.equal(malformed.status, 400)
    assert.equal(malformed.body.error.code, 'invalid_json')
  } finally {
    await server.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('disposing removes the current descriptor while cached help and guides remain readable', async () => {
  const { directory, server, run } = await start()
  try {
    assert.equal((await run(['--help'])).status, 0)
    await server.dispose()
    assert.throws(() => readFileSync(join(directory, 'current.json'), 'utf8'))

    const cachedHelp = await run(['--help'])
    assert.equal(cachedHelp.status, 0)
    assert.match(cachedHelp.stdout, /sample/)

    const cachedGuide = await run(['guide', 'sample'])
    assert.equal(cachedGuide.status, 0)
    assert.match(cachedGuide.stdout, /sample guide body/)
  } finally {
    await server.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})
