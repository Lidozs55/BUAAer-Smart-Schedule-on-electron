/**
 * Authenticated loopback transport for the `schedule` CLI.
 *
 * The plugin runs inside the DSH host; the CLI is a separate process started
 * by the agent's shell. They meet on 127.0.0.1:
 *
 *   - random ephemeral port, bound to loopback only
 *   - 256-bit bearer token written to a user-private discovery file
 *   - Host header check (DNS-rebinding fence), no CORS
 *   - only the registered command tree is reachable; there is no generic
 *     service/route passthrough
 *
 * The discovery directory defaults to `$DSH_HOME/schedule-cli` (or
 * `~/.dsh/schedule-cli`). `SCHEDULE_CLI_HOME` overrides it. The host also
 * copies the CLI and launchers there, so the agent does not need the package
 * path or a global npm install.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { copyFileSync, chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CLI_API_VERSION = 1
const MAX_BODY_BYTES = 5 * 1024 * 1024

export function scheduleCliHome() {
  if (process.env.SCHEDULE_CLI_HOME) return process.env.SCHEDULE_CLI_HOME
  if (process.env.DSH_HOME) return join(process.env.DSH_HOME, 'schedule-cli')
  return join(homedir(), '.dsh', 'schedule-cli')
}

function ensurePrivateDir(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  try { chmodSync(directory, 0o700) } catch { /* Windows ACLs; best effort */ }
}

function writePrivate(file, content) {
  ensurePrivateDir(dirname(file))
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(temporary, 0o600) } catch { /* Windows ACLs; best effort */ }
  try { rmSync(file, { force: true }) } catch { /* best effort */ }
  // rename is atomic on POSIX; the remove above makes it work on Windows too.
  renameSync(temporary, file)
  try { chmodSync(file, 0o600) } catch { /* Windows ACLs; best effort */ }
}

function installCliFiles(directory) {
  try {
    const source = fileURLToPath(new URL('../bin/schedule.js', import.meta.url))
    const target = join(directory, 'schedule.js')
    copyFileSync(source, target)
    try { chmodSync(target, 0o755) } catch { /* best effort */ }
    // Use the host's Node executable rather than bare `node`: the agent shell
    // may inherit a sanitized PATH. ELECTRON_RUN_AS_NODE keeps the launcher
    // working when the host runs under Electron (plain Node ignores it).
    const node = process.execPath
    writeFileSync(join(directory, 'schedule.cmd'),
      `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${node.replace(/%/g, '%%')}" "%~dp0schedule.js" %*\r\n`,
      { encoding: 'utf8' })
    const quoted = `'${node.replace(/'/g, `'\\''`)}'`
    writeFileSync(join(directory, 'schedule'),
      `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${quoted} "$(dirname "$0")/schedule.js" "$@"\n`,
      { encoding: 'utf8' })
    try { chmodSync(join(directory, 'schedule'), 0o755) } catch { /* best effort */ }
  } catch {
    // Help/execute still work through `bin/schedule.js`; a missing launcher
    // must not prevent the host from starting.
  }
}

/**
 * Make `schedule` runnable from the agent shell without a global install.
 * Agent shells inherit this process environment; the explicit launcher path
 * in the skill remains the fallback when the host sanitizes PATH.
 */
function ensureOnPath(directory) {
  const key = Object.keys(process.env).find(name => name.toUpperCase() === 'PATH') ?? 'PATH'
  const current = process.env[key] ?? ''
  const normalize = value => {
    let resolved = value
    try { resolved = resolve(value) } catch { /* keep the original */ }
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  const target = normalize(directory)
  const present = current.split(delimiter).some(part => part !== '' && normalize(part) === target)
  if (!present) process.env[key] = `${directory}${delimiter}${current}`
}

const json = (res, status, body) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(payload)
}

const ok = (res, value) => json(res, 200, { ok: true, value })
const fail = (res, status, code, message, details) =>
  json(res, status, { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } })

function sameToken(actual, expected) {
  const a = Buffer.from(String(actual))
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error('请求体过大'), { code: 'body_too_large' })
    }
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Start the loopback command server.
 * @param {object} ctx Cordis context (only `logger` is used, defensively).
 * @param {object} registry command registry from `createCommandRegistry`.
 * @param {object} [options]
 * @returns {Promise<{instanceId: string, port: number, directory: string, dispose: () => Promise<void>}>}
 */
export async function startScheduleCliServer(ctx, registry, options = {}) {
  if (process.env.SCHEDULE_CLI_DISABLE === '1') {
    return { instanceId: '', port: 0, directory: scheduleCliHome(), dispose: async () => {} }
  }

  const directory = options.directory ?? scheduleCliHome()
  const instanceId = options.instanceId ?? randomUUID()
  const token = randomBytes(32).toString('hex')
  const startedAt = new Date().toISOString()
  let currentPath = ''

  const server = createServer(async (req, res) => {
    const host = req.headers.host ?? ''
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return fail(res, 403, 'forbidden_host', '只接受本机回环请求')
    }
    const expected = `Bearer ${token}`
    if (!sameToken(req.headers.authorization ?? '', expected)) {
      return fail(res, 401, 'unauthorized', '缺少或无效的 CLI 访问令牌')
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    if (req.method === 'GET' && url.pathname === '/v1/health') {
      return ok(res, {
        apiVersion: CLI_API_VERSION,
        instanceId,
        pid: process.pid,
        startedAt,
      })
    }
    if (req.method === 'GET' && url.pathname === '/v1/catalog') {
      const catalog = registry.catalog()
      try { writePrivate(join(directory, 'catalog.json'), JSON.stringify(catalog)) } catch { /* cache is optional */ }
      return ok(res, catalog)
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/execute') {
      return fail(res, 404, 'not_found', `未知路由：${req.method} ${url.pathname}`)
    }

    const declaredSize = Number(req.headers['content-length'])
    if (Number.isFinite(declaredSize) && declaredSize > MAX_BODY_BYTES) {
      return fail(res, 413, 'body_too_large', '请求体过大')
    }
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      if (res.destroyed) return
      const tooLarge = error?.code === 'body_too_large'
      return fail(res, tooLarge ? 413 : 400, tooLarge ? 'body_too_large' : 'invalid_body',
        error?.message ?? '无法读取请求体')
    }
    if (body === undefined) {
      return fail(res, 400, 'invalid_json', '请求体不是合法 JSON 对象')
    }
    const path = body.path
    if (!Array.isArray(path) || path.length === 0
      || path.some(part => typeof part !== 'string' || part === '')) {
      return fail(res, 400, 'invalid_request', 'path 必须是非空字符串数组')
    }
    const command = path.join(' ')
    try {
      const value = await registry.execute(path, body.input ?? {}, {
        source: 'cli',
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
        remoteAddress: req.socket.remoteAddress,
      })
      return ok(res, value)
    } catch (error) {
      const code = error?.code ?? 'error'
      const message = error?.message ?? String(error)
      ctx?.logger?.warn?.('schedule-cli: %s failed (%s): %s', command, code, message)
      return json(res, 200, {
        ok: false,
        command,
        error: {
          code,
          message,
          ...(error?.details === undefined ? {} : { details: error.details }),
        },
      })
    }
  })

  await new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(0, '127.0.0.1')
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const descriptor = {
    apiVersion: CLI_API_VERSION,
    instanceId,
    pid: process.pid,
    port,
    token,
    startedAt,
  }

  ensurePrivateDir(directory)
  installCliFiles(directory)
  ensureOnPath(directory)
  const instancePath = join(directory, `instance-${instanceId}.json`)
  try {
    writePrivate(instancePath, JSON.stringify(descriptor))
    currentPath = join(directory, 'current.json')
    writePrivate(currentPath, JSON.stringify(descriptor))
    try { writePrivate(join(directory, 'catalog.json'), JSON.stringify(registry.catalog())) } catch { /* optional */ }
  } catch (error) {
    // A discovery failure must not leave an unreachable server or stale
    // instance file behind.
    await new Promise(resolve => server.close(() => resolve()))
    try { rmSync(instancePath, { force: true }) } catch { /* best effort */ }
    throw error
  }

  ctx?.logger?.info?.('schedule-cli: authenticated loopback server on 127.0.0.1:%d (instance %s)',
    port, instanceId)

  const dispose = async () => {
    await new Promise(resolve => server.close(() => resolve()))
    try { rmSync(instancePath, { force: true }) } catch { /* best effort */ }
    try {
      const current = JSON.parse(readFileSync(currentPath, 'utf8'))
      if (current?.instanceId === instanceId) rmSync(currentPath, { force: true })
    } catch { /* missing or replaced by another instance */ }
  }

  return { instanceId, port, directory, dispose }
}
