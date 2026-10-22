#!/usr/bin/env node
/**
 * `schedule` — thin CLI client for the DSH schedule plugin.
 *
 * Deliberately self-contained: the host copies this file to
 * `$DSH_HOME/schedule-cli/schedule.js` so the agent can run it without the
 * package path, a global npm install, or any import from the plugin bundle.
 *
 * Protocol: authenticated HTTP on 127.0.0.1. Discovery, token, catalog and
 * command dispatch all come from the running host; this file only parses
 * argv, renders help, and prints one JSON receipt per command.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const API_VERSION = 1
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024

/** Last parsed command path, used to shape JSON error envelopes. */
let activeCommand = []

class CliError extends Error {
  constructor(message, code = 'usage', exitCode = 2) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.exitCode = exitCode
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function cliHome() {
  if (process.env.SCHEDULE_CLI_HOME) return process.env.SCHEDULE_CLI_HOME
  if (process.env.DSH_HOME) return join(process.env.DSH_HOME, 'schedule-cli')
  return join(homedir(), '.dsh', 'schedule-cli')
}

function readDescriptor(instance) {
  const directory = cliHome()
  const file = instance
    ? join(directory, `instance-${instance}.json`)
    : join(directory, 'current.json')
  let descriptor
  try {
    descriptor = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new CliError([
      instance
        ? `找不到 CLI 实例描述：${file}`
        : `未发现运行中的日程实例（${file} 不存在）。`,
      '确认 DSH 宿主已启动且日程主插件已启用；安装或更新插件后重启宿主。',
      `如宿主使用了不同的 DSH_HOME，请用 SCHEDULE_CLI_HOME 指向同一目录（当前：${directory}）。`,
    ].join('\n'), 'host_unavailable')
  }
  if (descriptor?.apiVersion !== API_VERSION
    || !Number.isInteger(descriptor?.port)
    || typeof descriptor?.token !== 'string'
    || descriptor.token === '') {
    throw new CliError('CLI 实例描述无效或协议版本不匹配；请重启 DSH 宿主以刷新描述。', 'protocol_mismatch')
  }
  return descriptor
}

function httpCall(descriptor, method, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = httpRequest({
      host: '127.0.0.1',
      port: descriptor.port,
      method,
      path,
      timeout: timeoutMs,
      headers: {
        Authorization: `Bearer ${descriptor.token}`,
        Accept: 'application/json',
        ...(payload === undefined
          ? {}
          : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
      },
    }, res => {
      const chunks = []
      let size = 0
      res.on('data', chunk => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('宿主回执过大'))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed
        try { parsed = JSON.parse(text) } catch {
          reject(new CliError(`宿主返回了非 JSON 回执（HTTP ${res.statusCode}）`, 'protocol_error'))
          return
        }
        resolve({ status: res.statusCode, body: parsed })
      })
    })
    req.on('timeout', () => {
      req.destroy(new CliError(`请求超时（${timeoutMs} ms）；结果可能未知，先查询目标窗口再决定是否重试。`, 'timeout', 1))
    })
    req.on('error', error => {
      if (error instanceof CliError) return reject(error)
      if (error?.code === 'ECONNREFUSED' || error?.code === 'ECONNRESET' || error?.code === 'EHOSTUNREACH') {
        reject(new CliError('无法连接日程宿主：实例可能已停止或正在重启。', 'host_unavailable'))
        return
      }
      reject(new CliError(`CLI 请求失败：${error?.message ?? String(error)}`, 'connection_error'))
    })
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

function writeCache(catalog) {
  try {
    const directory = cliHome()
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const file = join(directory, 'catalog.json')
    writeFileSync(file, JSON.stringify(catalog), { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(file, 0o600) } catch { /* best effort */ }
  } catch { /* cache is optional */ }
}

function readCache() {
  try {
    const value = JSON.parse(readFileSync(join(cliHome(), 'catalog.json'), 'utf8'))
    return isObject(value) && Array.isArray(value.commands) ? value : undefined
  } catch {
    return undefined
  }
}

async function loadCatalog(descriptor, { allowCache = true } = {}) {
  if (descriptor === undefined) {
    const cached = allowCache ? readCache() : undefined
    if (cached) return cached
    throw new CliError('没有可用的命令目录；请先启动 DSH 宿主，或运行一次在线帮助。', 'host_unavailable')
  }
  try {
    const { status, body } = await httpCall(descriptor, 'GET', '/v1/catalog', undefined, DEFAULT_TIMEOUT_MS)
    if (status === 401) throw new CliError('CLI 访问令牌无效；实例可能已重启，请重试或重启宿主。', 'unauthorized')
    if (status !== 200 || body?.ok !== true) {
      throw new CliError(body?.error?.message ?? `读取命令目录失败（HTTP ${status}）`, body?.error?.code ?? 'protocol_error')
    }
    writeCache(body.value)
    return body.value
  } catch (error) {
    if (error instanceof CliError && error.code === 'unauthorized') throw error
    if (allowCache) {
      const cached = readCache()
      if (cached) return cached
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

const GLOBAL_VALUE_FLAGS = new Map([
  ['--instance', 'instance'],
  ['--input', 'input'],
  ['--session', 'session'],
  ['--password-env', 'passwordEnv'],
  ['--timeout', 'timeout'],
])

const GLOBAL_BOOLEAN_FLAGS = new Map([
  ['--help', 'help'],
  ['-h', 'help'],
  ['--password-stdin', 'passwordStdin'],
  ['--json', 'json'],
])

function extractGlobals(argv) {
  const globals = {
    help: false,
    json: true,
    passwordStdin: false,
    instance: undefined,
    input: undefined,
    session: undefined,
    passwordEnv: undefined,
    timeout: undefined,
  }
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--') {
      rest.push(...argv.slice(i))
      break
    }
    const [flag, inline] = token.includes('=') ? token.split(/=(.*)/s, 2) : [token, undefined]
    if (GLOBAL_BOOLEAN_FLAGS.has(flag)) {
      globals[GLOBAL_BOOLEAN_FLAGS.get(flag)] = inline === undefined ? true : inline !== 'false'
      continue
    }
    if (GLOBAL_VALUE_FLAGS.has(flag)) {
      const value = inline !== undefined ? inline : argv[i + 1]
      if (value === undefined) throw new CliError(`选项 ${flag} 缺少值`, 'usage')
      globals[GLOBAL_VALUE_FLAGS.get(flag)] = value
      if (inline === undefined) i += 1
      continue
    }
    rest.push(token)
  }
  if (globals.timeout !== undefined) {
    const value = Number(globals.timeout)
    if (!Number.isInteger(value) || value <= 0) {
      throw new CliError('--timeout 必须是正整数毫秒数', 'usage')
    }
    globals.timeout = value
  }
  return { globals, rest }
}

function splitPath(rest) {
  const path = []
  let index = 0
  while (index < rest.length && !rest[index].startsWith('-')) {
    path.push(rest[index])
    index += 1
  }
  return { path, args: rest.slice(index) }
}

function findCommand(catalog, path) {
  let node = catalog.commands.find(command => command.name === path[0])
  for (const part of path.slice(1)) {
    if (!node) return undefined
    node = (node.children ?? []).find(child => child.name === part)
  }
  return node
}

function renderOption(option) {
  const type = option.type === 'boolean' ? '' : ` <${option.type}>`
  const required = option.required ? '必填；' : ''
  const fallback = option.default !== undefined && option.type !== 'boolean'
    ? `默认 ${JSON.stringify(option.default)}；`
    : ''
  const repeated = option.repeated ? '（可重复）' : ''
  const negation = option.type === 'boolean'
    && option.default === true
    && !option.description.includes(`--no-${option.name}`)
    ? `（--no-${option.name} 关闭）`
    : ''
  return `  --${option.name}${type}  ${required}${fallback}${option.description}${repeated}${negation}`.trimEnd()
}

function renderHelp(catalog, path) {
  if (path.length === 0) {
    const lines = [
      `${catalog.name ?? 'schedule'} — 日程、待办与来源导入 CLI`,
      '',
      '用法：',
      `  ${catalog.name ?? 'schedule'} <命令> [子命令] [选项]`,
      `  ${catalog.name ?? 'schedule'} <命令> --help`,
      `  ${catalog.name ?? 'schedule'} guide <主题>`,
      '',
      '命令：',
      ...(catalog.commands ?? []).map(command => `  ${command.name.padEnd(12)}${command.summary}`),
    ]
    if ((catalog.guides ?? []).length > 0) {
      lines.push('', '指南（较长教程按需加载）：')
      for (const guide of catalog.guides) {
        lines.push(`  ${guide.name.padEnd(12)}${guide.title}${guide.summary ? ` — ${guide.summary}` : ''}`)
      }
      lines.push('', '运行 `schedule guide <主题>` 查看完整教程。')
    }
    lines.push('', '提示：先看本页，再进入 `schedule <命令> --help`；参数与副作用以叶子帮助为准。')
    return lines.join('\n')
  }

  const node = findCommand(catalog, path)
  if (!node) throw new CliError(`未知命令：${path.join(' ')}`, 'unknown_command')
  const full = `${catalog.name ?? 'schedule'} ${path.join(' ')}`
  const isGroup = (node.children ?? []).length > 0
  const usage = node.usage ?? (isGroup
    ? `${full} <子命令> [选项]`
    : `${full} [选项]`)
  const lines = [
    `${full} — ${node.summary}`,
    '',
    '用法：',
    `  ${usage}`,
  ]
  if (node.description) lines.push('', node.description)
  if (isGroup) {
    lines.push('', '子命令：')
    for (const child of node.children) lines.push(`  ${child.name.padEnd(14)}${child.summary}`)
    lines.push('', `运行 \`${full} <子命令> --help\` 查看参数与示例。`)
  }
  const options = (node.options ?? []).filter(option => option.hidden !== true)
  if (options.length > 0) {
    lines.push('', '选项：', ...options.map(renderOption))
  }
  if ((node.examples ?? []).length > 0) {
    lines.push('', '示例：', ...node.examples.map(example => `  ${example}`))
  }
  if ((node.notes ?? []).length > 0) {
    lines.push('', '注意：', ...node.notes.map(note => `  - ${note}`))
  }
  if (!isGroup) {
    const universal = [
      '  --input <file|->     从 JSON 文件或 stdin 读取输入；根为数组时自动作为 batch-create 的 entries',
      '  --session <id>       当前 DSH 会话 id（默认读 SCHEDULE_SESSION_ID / DSH_SESSION_ID）',
      '  --instance <id>      多宿主时指定实例',
      '  --timeout <ms>       请求超时（长任务默认更高）',
    ]
    if ((node.options ?? []).some(option => option.name === 'password' && option.hidden)) {
      universal.push(
        '  --password-stdin     从 stdin 读取来源密码；不进入命令行参数或 shell 历史',
        '  --password-env NAME  从环境变量读取来源密码',
      )
    }
    lines.push('', '通用选项：', ...universal)
  }
  return lines.join('\n')
}

function renderGuideIndex(catalog) {
  const lines = ['可用指南：']
  if ((catalog.guides ?? []).length === 0) lines.push('  （当前没有指南）')
  for (const guide of catalog.guides ?? []) {
    lines.push(`  ${guide.name.padEnd(12)}${guide.title}${guide.summary ? ` — ${guide.summary}` : ''}`)
  }
  lines.push('', '运行 `schedule guide <主题>` 查看完整教程。')
  return lines.join('\n')
}

function renderGuide(catalog, topic) {
  if (topic === undefined) return renderGuideIndex(catalog)
  const guide = (catalog.guides ?? []).find(item => item.name === topic)
  if (!guide) {
    throw new CliError(`未知指南：${topic}\n\n${renderGuideIndex(catalog)}`, 'unknown_command')
  }
  return `${guide.title}\n\n${guide.body}`
}

function renderOfflineHelp(catalog, targetPath) {
  return targetPath[0] === 'guide'
    ? renderGuide(catalog, targetPath[1])
    : renderHelp(catalog, targetPath)
}

function printStaticHelp() {
  return [
    'schedule — 日程、待办与来源导入 CLI',
    '',
    '当前未发现运行中的 DSH 日程实例，无法加载完整命令目录。',
    '',
    '检查：',
    '  1. DSH 宿主正在运行，且日程主插件已启用。',
    '  2. 安装/更新插件后已重启宿主。',
    '  3. CLI 与宿主使用同一目录：默认 ~/.dsh/schedule-cli，可用 SCHEDULE_CLI_HOME 覆盖。',
    '',
    '宿主启动后运行 `schedule --help` 获取命令、分层帮助与 guide 主题。',
  ].join('\n')
}

function coerceValue(option, raw) {
  let value = raw
  switch (option.type) {
    case 'string':
      value = String(raw)
      break
    case 'number': {
      value = Number(raw)
      if (!Number.isFinite(value)) throw new CliError(`--${option.name} 必须是数字`, 'usage')
      break
    }
    case 'integer': {
      value = Number(raw)
      if (!Number.isInteger(value)) throw new CliError(`--${option.name} 必须是整数`, 'usage')
      break
    }
    case 'json':
      try { value = JSON.parse(raw) } catch {
        throw new CliError(`--${option.name} 必须是合法 JSON`, 'usage')
      }
      break
    case 'array':
      try { value = JSON.parse(raw) } catch {
        throw new CliError(`--${option.name} 必须是 JSON 数组`, 'usage')
      }
      if (!Array.isArray(value)) throw new CliError(`--${option.name} 必须是 JSON 数组`, 'usage')
      break
    default:
      value = raw
  }
  if (option.enum !== undefined && !option.enum.includes(value)) {
    throw new CliError(`--${option.name} 须为 ${option.enum.join(' | ')}`, 'usage')
  }
  return value
}

function parseCommandArgs(node, args) {
  const definitions = new Map((node.options ?? []).map(option => [option.name, option]))
  const input = {}
  const positionals = []
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]
    if (token === '--') {
      positionals.push(...args.slice(i + 1))
      break
    }
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const body = token.slice(2)
    const equal = body.indexOf('=')
    let name = equal === -1 ? body : body.slice(0, equal)
    let inline = equal === -1 ? undefined : body.slice(equal + 1)
    let negated = false
    if (name.startsWith('no-')) {
      negated = true
      name = name.slice(3)
    }
    const option = definitions.get(name)
    if (option === undefined) {
      throw new CliError(`命令 ${node.name} 不支持选项 --${name}；运行 \`schedule ${node.name} --help\``, 'usage')
    }
    if (option.hidden === true) {
      throw new CliError(`--${name} 不能直接作为命令行参数；密码请用 --password-stdin 或 --password-env`, 'usage')
    }
    let value
    if (option.type === 'boolean') {
      if (inline !== undefined) {
        if (inline !== 'true' && inline !== 'false') {
          throw new CliError(`--${name} 只接受 true/false`, 'usage')
        }
        value = inline === 'true'
      } else {
        value = true
      }
      if (negated) value = !value
    } else {
      if (negated) throw new CliError(`--no-${name} 只能用于布尔选项`, 'usage')
      if (inline === undefined) {
        const next = args[i + 1]
        const negativeNumber = (option.type === 'number' || option.type === 'integer')
          && typeof next === 'string' && /^-(?:\d|\.\d)/.test(next)
        if (next === undefined || (next.startsWith('-') && next !== '-' && !negativeNumber)) {
          throw new CliError(`--${name} 缺少值`, 'usage')
        }
        value = next
        i += 1
      } else {
        value = inline
      }
      value = coerceValue(option, value)
    }
    if (option.repeated) {
      if (input[name] === undefined) input[name] = []
      input[name].push(value)
    } else {
      if (input[name] !== undefined) throw new CliError(`--${name} 重复出现`, 'usage')
      input[name] = value
    }
  }
  if (positionals.length > 0) {
    throw new CliError(`无法识别的参数：${positionals.join(' ')}`, 'usage')
  }
  return input
}

function readStdin() {
  return readFileSync(0, 'utf8')
}

function readInputFile(spec, path) {
  let text
  if (spec === '-') {
    text = readStdin()
  } else {
    if (!existsSync(spec)) throw new CliError(`输入文件不存在：${spec}`, 'usage')
    text = readFileSync(spec, 'utf8')
  }
  text = text.replace(/^\uFEFF/, '')
  let parsed
  try { parsed = JSON.parse(text) } catch {
    throw new CliError('--input 必须是合法 JSON', 'usage')
  }
  if (Array.isArray(parsed) && path.join(' ') === 'entry batch-create') {
    return { entries: parsed }
  }
  if (!isObject(parsed)) throw new CliError('--input 的根必须是对象（batch-create 可为数组）', 'usage')
  return parsed
}

function assertPasswordTransport(globals) {
  if (globals.passwordStdin && globals.passwordEnv) {
    throw new CliError('--password-stdin 与 --password-env 只能选一个', 'usage')
  }
  if (globals.passwordStdin && globals.input === '-') {
    throw new CliError('--password-stdin 不能与 --input - 同时使用', 'usage')
  }
}

function withPassword(input, globals) {
  if (!globals.passwordStdin && !globals.passwordEnv) return input
  let password
  if (globals.passwordStdin) {
    password = readStdin().replace(/\r?\n$/, '')
  } else {
    password = process.env[globals.passwordEnv]
  }
  if (typeof password !== 'string' || password === '') {
    throw new CliError(globals.passwordStdin
      ? '未从 stdin 读到密码'
      : `环境变量 ${globals.passwordEnv} 为空或未设置`, 'usage')
  }
  return { ...input, password }
}

function applyDefaults(node, input) {
  for (const option of node.options ?? []) {
    if (input[option.name] === undefined && option.default !== undefined) {
      input[option.name] = option.default
    }
    if (option.required && input[option.name] === undefined) {
      throw new CliError(`缺少必填选项 --${option.name}；运行帮助查看用法`, 'usage')
    }
  }
  return input
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function printEnvelope(path, body) {
  const command = path.join('.')
  if (body?.ok === true) {
    printJson({ ok: true, command, value: body.value })
    return 0
  }
  const error = body?.error ?? { code: 'error', message: '未知错误' }
  printJson({ ok: false, command, error })
  return error.code === 'usage' || error.code === 'unknown_command' ? 2 : 1
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const { globals, rest } = extractGlobals(process.argv.slice(2))
  const { path, args } = splitPath(rest)

  // `schedule help [path]` is a help alias, not a command. A bare `schedule`
  // is also a help request, so it still works when no host is running.
  const helpRequested = globals.help || path[0] === 'help' || path.length === 0
    || (path[0] === 'guide' && path.length === 1)
  const targetPath = path[0] === 'help' ? path.slice(1) : path
  activeCommand = targetPath

  let descriptor
  try { descriptor = readDescriptor(globals.instance) } catch (error) {
    if (helpRequested || targetPath[0] === 'guide') {
      const cached = readCache()
      if (cached) {
        process.stdout.write(`${renderOfflineHelp(cached, targetPath)}\n`)
        return 0
      }
      process.stdout.write(`${printStaticHelp()}\n`)
      return 0
    }
    throw error
  }

  let catalog
  try {
    catalog = await loadCatalog(descriptor, { allowCache: true })
  } catch (error) {
    if (!helpRequested) throw error
    process.stdout.write(`${printStaticHelp()}\n`)
    return 0
  }

  if (targetPath[0] === 'guide') {
    process.stdout.write(`${renderGuide(catalog, targetPath[1])}\n`)
    return 0
  }

  if (targetPath.length === 0) {
    process.stdout.write(`${renderHelp(catalog, [])}\n`)
    return 0
  }

  const node = findCommand(catalog, targetPath)
  if (!node) throw new CliError(`未知命令：${targetPath.join(' ')}`, 'unknown_command')

  if (helpRequested || (node.children ?? []).length > 0 && args.length === 0) {
    process.stdout.write(`${renderHelp(catalog, targetPath)}\n`)
    return 0
  }
  if ((node.children ?? []).length > 0) {
    throw new CliError(`命令组需要子命令；运行 \`schedule ${targetPath.join(' ')} --help\``, 'usage')
  }

  let input = parseCommandArgs(node, args)
  assertPasswordTransport(globals)
  if (globals.input !== undefined) {
    input = { ...readInputFile(globals.input, targetPath), ...input }
  }
  input = withPassword(input, globals)
  input = applyDefaults(node, input)

  const sessionId = globals.session
    ?? process.env.SCHEDULE_SESSION_ID
    ?? process.env.DSH_SESSION_ID
  const timeoutMs = globals.timeout ?? Math.max(DEFAULT_TIMEOUT_MS, node.timeoutMs ?? 0)

  let response
  try {
    response = await httpCall(descriptor, 'POST', '/v1/execute', {
      path: targetPath,
      input,
      ...(sessionId ? { sessionId } : {}),
    }, timeoutMs)
  } catch (error) {
    if (error instanceof CliError) {
      printJson({ ok: false, command: targetPath.join('.'), error: { code: error.code, message: error.message } })
      return error.exitCode ?? 2
    }
    throw error
  }

  if (response.status === 401) {
    throw new CliError('CLI 访问令牌无效；实例可能已重启，请重试或重启宿主。', 'unauthorized')
  }
  return printEnvelope(targetPath, response.body)
}

main()
  .then(code => { process.exitCode = code ?? 0 })
  .catch(error => {
    if (error instanceof CliError) {
      printJson({
        ok: false,
        command: activeCommand.join('.'),
        error: { code: error.code, message: error.message },
      })
      process.exitCode = error.exitCode ?? 2
      return
    }
    printJson({
      ok: false,
      command: activeCommand.join('.'),
      error: { code: 'internal_error', message: error?.message ?? String(error) },
    })
    process.exitCode = 1
  })
