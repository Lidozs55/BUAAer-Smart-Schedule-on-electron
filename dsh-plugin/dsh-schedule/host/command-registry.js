/**
 * Structured command registry behind the `schedule` CLI.
 *
 * The model no longer receives a tool schema. It runs the CLI, discovers the
 * command tree through `--help`, and the CLI forwards one JSON request to the
 * host. This registry is the host-side single source for:
 *
 *   - command lookup and dispatch (core and source plugins both register here)
 *   - option validation, so the CLI cannot reach arbitrary service methods
 *   - the public catalog rendered as layered help
 *
 * A command definition is data plus one handler. Help text, examples and the
 * option list all live next to the handler, which keeps source plugins from
 * having to edit the core skill or duplicate knowledge in prose.
 */

export const COMMAND_CATALOG_VERSION = 1

const NAME_RE = /^[a-z][a-z0-9-]*$/
const OPTION_TYPES = new Set(['string', 'boolean', 'number', 'integer', 'json', 'array'])

export class CommandError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'CommandError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

const fail = (code, message, details) => {
  throw new CommandError(code, message, details)
}

const isPlainObject = value =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function checkName(name, kind) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    fail('invalid_definition', `${kind}名称必须匹配 ${NAME_RE}：${name}`)
  }
}

function normalizeOption(name, spec) {
  checkName(name, '选项')
  if (!isPlainObject(spec)) fail('invalid_definition', `选项 ${name} 必须是对象`)
  if (!OPTION_TYPES.has(spec.type)) {
    fail('invalid_definition', `选项 ${name} 的 type 不受支持：${spec.type}`)
  }
  if (spec.enum !== undefined) {
    if (!Array.isArray(spec.enum) || spec.enum.length === 0) {
      fail('invalid_definition', `选项 ${name} 的 enum 必须是非空数组`)
    }
    for (const value of spec.enum) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        fail('invalid_definition', `选项 ${name} 的 enum 只能包含标量`)
      }
    }
  }
  return {
    name,
    type: spec.type,
    description: spec.description ?? '',
    required: spec.required === true,
    repeated: spec.repeated === true,
    hidden: spec.hidden === true,
    enum: spec.enum,
    default: spec.default,
  }
}

function normalizeCommand(definition, owner) {
  if (!isPlainObject(definition)) fail('invalid_definition', '命令定义必须是对象')
  checkName(definition.name, '命令')
  const children = definition.commands === undefined ? [] : definition.commands
  if (!Array.isArray(children)) fail('invalid_definition', `${definition.name}.commands 必须是数组`)
  if (children.length === 0 && typeof definition.run !== 'function') {
    fail('invalid_definition', `命令 ${definition.name} 没有子命令时必须提供 run`)
  }
  if (children.length > 0 && definition.run !== undefined) {
    fail('invalid_definition', `命令组 ${definition.name} 不能同时提供 run`)
  }
  const options = new Map()
  for (const [name, spec] of Object.entries(definition.options ?? {})) {
    if (options.has(name)) fail('invalid_definition', `重复选项：${name}`)
    options.set(name, normalizeOption(name, spec))
  }
  const childMap = new Map()
  for (const child of children) {
    const node = normalizeCommand(child, owner)
    if (childMap.has(node.name)) {
      fail('invalid_definition', `${definition.name} 下重复子命令：${node.name}`)
    }
    childMap.set(node.name, node)
  }
  return {
    name: definition.name,
    summary: definition.summary ?? '',
    description: definition.description ?? '',
    usage: definition.usage,
    examples: Array.isArray(definition.examples) ? definition.examples.map(String) : [],
    notes: Array.isArray(definition.notes) ? definition.notes.map(String) : [],
    timeoutMs: definition.timeoutMs,
    options,
    children: childMap,
    run: definition.run,
    owner,
  }
}

function publicCommand(node) {
  return {
    name: node.name,
    summary: node.summary,
    description: node.description,
    usage: node.usage,
    examples: node.examples,
    notes: node.notes,
    timeoutMs: node.timeoutMs,
    options: [...node.options.values()].map(option => ({ ...option })),
    children: [...node.children.values()].map(publicCommand),
  }
}

function coerceOption(option, value) {
  if (option.repeated) {
    const list = Array.isArray(value) ? value : [value]
    return list.map(item => coerceSingle(option, item))
  }
  return coerceSingle(option, value)
}

function coerceSingle(option, value) {
  switch (option.type) {
    case 'string':
      if (typeof value !== 'string') fail('usage', `选项 ${option.name} 必须是字符串`)
      break
    case 'boolean':
      if (typeof value !== 'boolean') fail('usage', `选项 ${option.name} 必须是布尔值`)
      break
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail('usage', `选项 ${option.name} 必须是数字`)
      }
      break
    case 'integer':
      if (!Number.isInteger(value)) fail('usage', `选项 ${option.name} 必须是整数`)
      break
    case 'array':
      if (!Array.isArray(value)) fail('usage', `选项 ${option.name} 必须是数组`)
      break
    case 'json':
      break
    default:
      fail('invalid_definition', `未知选项类型：${option.type}`)
  }
  if (option.enum !== undefined && !option.enum.includes(value)) {
    fail('usage', `选项 ${option.name} 须为 ${option.enum.join(' | ')}`)
  }
  return value
}

/**
 * @param {object} [options]
 * @param {string} [options.name] CLI name, used in help and catalog metadata.
 */
export function createCommandRegistry({ name = 'schedule' } = {}) {
  const roots = new Map()
  const guides = new Map()

  function register(definition, { owner = 'plugin' } = {}) {
    const node = normalizeCommand(definition, owner)
    if (roots.has(node.name)) fail('invalid_definition', `重复命令命名空间：${node.name}`)
    roots.set(node.name, node)
    return () => {
      if (roots.get(node.name) === node) roots.delete(node.name)
    }
  }

  function registerGuide(guide) {
    if (!isPlainObject(guide)) fail('invalid_definition', 'guide 必须是对象')
    checkName(guide.name, 'guide')
    if (typeof guide.body !== 'string' || guide.body.trim() === '') {
      fail('invalid_definition', `guide ${guide.name} 必须有正文`)
    }
    if (guides.has(guide.name)) fail('invalid_definition', `重复 guide：${guide.name}`)
    const entry = {
      name: guide.name,
      title: guide.title ?? guide.name,
      summary: guide.summary ?? '',
      body: guide.body,
    }
    guides.set(entry.name, entry)
    return () => {
      if (guides.get(entry.name) === entry) guides.delete(entry.name)
    }
  }

  function catalog() {
    return {
      version: COMMAND_CATALOG_VERSION,
      name,
      commands: [...roots.values()].map(publicCommand),
      guides: [...guides.values()].map(guide => ({ ...guide })),
    }
  }

  function resolve(path) {
    if (!Array.isArray(path) || path.length === 0) return undefined
    let node = roots.get(path[0])
    for (const part of path.slice(1)) {
      if (node === undefined) return undefined
      node = node.children.get(part)
    }
    return node
  }

  function validateInput(node, input) {
    if (input === undefined || input === null) input = {}
    if (!isPlainObject(input)) fail('usage', '命令输入必须是 JSON 对象')
    const value = {}
    for (const [name, raw] of Object.entries(input)) {
      const option = node.options.get(name)
      if (option === undefined) {
        fail('usage', `命令 ${node.name} 不支持选项 ${name}`)
      }
      value[name] = raw
    }
    for (const option of node.options.values()) {
      if (value[option.name] === undefined) {
        if (option.default !== undefined) value[option.name] = option.default
        else if (option.required) fail('usage', `缺少必填选项：${option.name}`)
      } else {
        value[option.name] = coerceOption(option, value[option.name])
      }
    }
    return value
  }

  async function execute(path, input, context = {}) {
    const node = resolve(path)
    if (node === undefined) {
      fail('unknown_command', `未知命令：${path.join(' ')}`)
    }
    if (typeof node.run !== 'function') {
      fail('usage', `命令 ${path.join(' ')} 是命令组，需要继续指定子命令`)
    }
    return node.run(validateInput(node, input), context)
  }

  return {
    name,
    register,
    registerGuide,
    catalog,
    resolve,
    execute,
  }
}
