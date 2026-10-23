import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

/** Minimal client harness (same shape as client.tasks.test.mjs). */
async function harness({ clipboardText = '' } = {}) {
  const modules = new Map()
  let slots = []
  let cursor = 0
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const React = {
    Fragment: Symbol.for('react.fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
    },
    useRef(initial) {
      const index = cursor++
      return slots[index] ??= { current: initial }
    },
    useMemo(factory, deps) {
      const index = cursor++
      if (!sameDeps(slots[index]?.deps, deps)) slots[index] = { value: factory(), deps }
      return slots[index].value
    },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps) },
    useEffect(fn) { fn() },
  }
  modules.set('react', React)
  const window = { __ModuleLoader__: { load: ({ id, factory }) => modules.set(id, factory(id => modules.get(id))) } }
  class MockFileReader {
    readAsDataURL(file) {
      this.result = `data:${file.type};base64,${file.data}`
      this.onload?.()
    }
  }
  const context = vm.createContext({
    window,
    console,
    Date,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    FileReader: MockFileReader,
    crypto: { randomUUID: () => 'request-1' },
    navigator: { clipboard: { readText: async () => clipboardText } },
    document: { visibilityState: 'visible' },
  })
  for (const name of ['core', 'clipboard']) {
    vm.runInContext(await readFile(new URL(`../client.${name}.js`, import.meta.url), 'utf8'), context)
  }
  return {
    module: name => modules.get(`@lidozs55/dsh-schedule/client.${name}.js`),
    render(component, props) {
      cursor = 0
      return component(props)
    },
  }
}

const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)]
const queueTexts = tree => nodes(tree)
  .filter(node => node.props?.className === 'bsch-textarea')
  .map(node => node.props.value)

test('a confirmed pet drop opens a session directly and is acked once', async () => {
  const client = await harness()
  let confirmed = [
    { id: 'drop-1', text: '明天 14:00 交实验报告', at: '2026-10-22T00:00:00.000Z', confirmedAt: '2026-10-22T00:00:01.000Z' },
  ]
  const created = []
  const prompts = []
  const opened = []
  const acked = []
  const api = {
    listConfirmedDrops: async () => confirmed,
    ackDrops: async ids => {
      acked.push(...ids)
      confirmed = confirmed.filter(row => !ids.includes(row.id))
      return ids.length
    },
  }
  const env = {
    session: {
      create: async () => {
        created.push('s1')
        return { ok: true, value: { sessionId: 's1' } }
      },
      prompt: async request => {
        prompts.push(request)
        return { ok: true, value: { accepted: true } }
      },
    },
    openSession: id => opened.push(id),
  }
  const stop = client.module('clipboard').startClipboardMonitor({
    api, env, intervalMs: 50, dropIntervalMs: 10,
  })
  await new Promise(resolve => setTimeout(resolve, 35))
  stop()

  assert.deepEqual(created, ['s1'])
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].sessionId, 's1')
  assert.equal(prompts[0].content[0].type, 'text')
  assert.match(prompts[0].content[0].text, /明天 14:00 交实验报告/)
  assert.match(prompts[0].content[0].text, /在最终写入前/)
  assert.match(prompts[0].content[0].text, /等我明确确认/)
  assert.deepEqual(opened, ['s1'])
  assert.deepEqual(acked, ['drop-1'])
  assert.deepEqual(confirmed, [])
})

test('a confirmed image+text drop rides the prompt as text and image parts', async () => {
  const client = await harness()
  let confirmed = [{
    id: 'drop-img',
    text: '按截图建日程',
    images: [{ mediaType: 'image/png', data: 'aGVsbG8=', name: 'plan.png' }],
  }]
  const prompts = []
  const api = {
    listConfirmedDrops: async () => confirmed,
    ackDrops: async ids => {
      confirmed = confirmed.filter(row => !ids.includes(row.id))
      return ids.length
    },
  }
  const env = {
    session: {
      create: async () => ({ ok: true, value: { sessionId: 's-img' } }),
      prompt: async request => {
        prompts.push(request)
        return { ok: true, value: { accepted: true } }
      },
    },
    openSession() {},
  }
  const stop = client.module('clipboard').startClipboardMonitor({
    api, env, intervalMs: 50, dropIntervalMs: 10,
  })
  await new Promise(resolve => setTimeout(resolve, 35))
  stop()

  assert.equal(prompts.length, 1)
  assert.match(prompts[0].content[0].text, /按截图建日程/)
  assert.match(prompts[0].content[0].text, /1 张图片/)
  assert.equal(prompts[0].content[1].type, 'image')
  assert.equal(prompts[0].content[1].name, 'plan.png')
  assert.deepEqual(confirmed, [])
})

test('a host without listConfirmedDrops is silent and leaves the queue empty', async () => {
  const client = await harness()
  const stop = client.module('clipboard').startClipboardMonitor({
    api: { listConfirmedDrops: undefined },
    env: { session: { create: async () => { throw new Error('must not create') } } },
    intervalMs: 10,
    dropIntervalMs: 10,
  })
  await new Promise(resolve => setTimeout(resolve, 25))
  stop()

  const { ClipboardTab } = client.module('clipboard')
  const tree = client.render(ClipboardTab, {
    t: key => key,
    env: { session: {}, openSession() {} },
  })
  assert.deepEqual(queueTexts(tree), [])
})

test('an image picked as an attachment rides the prompt as an image content part', async () => {
  const client = await harness()
  const prompts = []
  let resolvePrompt
  const prompted = new Promise(resolve => { resolvePrompt = resolve })
  const env = {
    session: {
      create: async () => ({ ok: true, value: { sessionId: 's1' } }),
      prompt: async request => {
        prompts.push(request)
        resolvePrompt()
        return { ok: true, value: { accepted: true } }
      },
    },
    openSession() {},
  }
  const props = { t: key => key, env }
  let tree = client.render(client.module('clipboard').ClipboardTab, props)
  const picker = nodes(tree).find(node => node.props?.type === 'file')
  assert.ok(picker, 'the attachment picker is rendered')

  await picker.props.onChange({
    target: {
      files: [{ name: 'plan.png', type: 'image/png', size: 5, data: 'aGVsbG8=' }],
      value: '',
    },
  })
  tree = client.render(client.module('clipboard').ClipboardTab, props)
  const images = nodes(tree).filter(node => node.props?.className === 'bsch-attachment-img')
  assert.equal(images.length, 1)
  assert.equal(images[0].props.src, 'data:image/png;base64,aGVsbG8=')

  const send = nodes(tree).find(node => node.props?.className === 'bsch-btn is-primary')
  await send.props.onClick()
  await prompted

  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].content[0].type, 'text')
  assert.match(prompts[0].content[0].text, /随消息附带 1 张图片/)
  assert.match(prompts[0].content[0].text, /plan\.png/)
  assert.equal(prompts[0].content[1].type, 'image')
  assert.equal(prompts[0].content[1].mediaType, 'image/png')
  assert.equal(prompts[0].content[1].data, 'aGVsbG8=')
  assert.equal(prompts[0].content[1].name, 'plan.png')
})

test('a text-only queue still sends one text content part', async () => {
  const client = await harness({ clipboardText: '明天 9 点开会' })
  const stop = client.module('clipboard').startClipboardMonitor({ intervalMs: 10 })
  await new Promise(resolve => setTimeout(resolve, 25))
  stop()

  const prompts = []
  let resolvePrompt
  const prompted = new Promise(resolve => { resolvePrompt = resolve })
  const env = {
    session: {
      create: async () => ({ ok: true, value: { sessionId: 's2' } }),
      prompt: async request => {
        prompts.push(request)
        resolvePrompt()
        return { ok: true, value: { accepted: true } }
      },
    },
    openSession() {},
  }
  const props = { t: key => key, env }
  let tree = client.render(client.module('clipboard').ClipboardTab, props)
  assert.deepEqual(queueTexts(tree), ['明天 9 点开会'])

  const send = nodes(tree).find(node => node.props?.className === 'bsch-btn is-primary')
  await send.props.onClick()
  await prompted

  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].content.length, 1)
  assert.equal(prompts[0].content[0].type, 'text')
  assert.match(prompts[0].content[0].text, /明天 9 点开会/)
  assert.match(prompts[0].content[0].text, /在最终写入前/)
})

