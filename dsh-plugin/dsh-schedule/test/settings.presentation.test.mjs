import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...(tree.children ?? []).flatMap(nodes)]
const find = (tree, predicate) => nodes(tree).find(predicate)
const hasClass = (node, name) => node.props.className?.split(' ').includes(name)
const flush = () => new Promise(resolve => setImmediate(resolve))

async function sourceApp(source, initial, options = {}) {
  let cursor = 0
  const slots = [], effects = [], calls = [], modules = new Map()
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState(value) { const i = cursor++; if (!(i in slots)) slots[i] = typeof value === 'function' ? value() : value; return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next }] },
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value } },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || deps.some((v, j) => !Object.is(v, slots[i][j]))) { slots[i] = deps; effects.push(fn) } },
  }
  let state = initial
  const context = vm.createContext({
    console, Date, CustomEvent: class { constructor(type) { this.type = type } },
    window: { dispatchEvent() {}, __ModuleLoader__: { load({ id, factory }) { modules.set(id, factory(id => id === 'react' ? React : modules.get(id))) } } },
    fetch: async (_url, request) => {
      if (request) {
        const body = JSON.parse(request.body)
        calls.push(body)
        if (options.fail) return { json: async () => ({ ok: false, error: { message: 'Request failed' } }) }
        if (body.op === 'setSpocEnabled') state = { ...state, spocEnabled: body.enabled }
        if (body.op === 'setStudentId') state = { ...state, buaaId: body.buaaId }
        if (body.op === 'setEnabled') state = { ...state, games: state.games.map(g => g.id === body.game ? { ...g, enabled: body.enabled } : g) }
      }
      return { json: async () => ({ ok: true, value: state }) }
    },
  })
  const prefix = source === 'buaa' ? '@buaaer' : '@lidozs55'
  const base = new URL(`../../dsh-schedule-${source}/`, import.meta.url)
  if (source === 'buaa') vm.runInContext(await readFile(new URL('client.api.js', base), 'utf8'), context)
  vm.runInContext(await readFile(new URL('client.settings.js', base), 'utf8'), context)
  const module = modules.get(`${prefix}/dsh-schedule-${source}/client.settings.js`)
  const locale = options.locale ?? 'zh'
  const render = () => { cursor = 0; const tree = module.SettingsSection({ t: key => module[locale][key] ?? key, env: {} }); effects.splice(0).forEach(fn => fn()); return tree }
  render()
  await flush()
  return { render, calls, module }
}

const buaaState = { buaaId: 'test-student', termStart: '2026-09-07', termLabel: '2026 秋季', spocEnabled: true, spocSession: null, signinSession: null }
const gachaState = { games: [{ id: 'genshin', name: '原神', enabled: true, status: 'ready', plan: { version: '6.0', updateStart: null, previewStart: null }, article: null }], refreshing: false, lastRefreshAt: null }

for (const source of ['buaa', 'gacha']) {
  test(`${source} uses shared settings rows, heading and action alignment in both languages`, async () => {
    for (const locale of ['zh', 'en']) {
      const app = await sourceApp(source, source === 'buaa' ? buaaState : gachaState, { locale })
      const tree = app.render()
      assert.ok(hasClass(tree, 'bsch-settings-section'))
      assert.ok(find(tree, n => hasClass(n, 'bsch-settings-heading') && n.type === 'h3'))
      assert.ok(find(tree, n => hasClass(n, 'bsch-setting-row')))
      assert.ok(find(tree, n => hasClass(n, 'bsch-settings-actions')))
      assert.equal(find(tree, n => n.props.style), undefined, 'layout should come from shared CSS, not inline overrides')
    }
  })
}

test('BUAA inputs have explicit labels and preserve student ID save and SPOC toggle', async () => {
  const app = await sourceApp('buaa', buaaState)
  let tree = app.render()
  const student = find(tree, n => n.type === 'input' && n.props.id === 'bsch-buaa-id')
  assert.ok(student)
  assert.ok(find(tree, n => n.type === 'label' && n.props.htmlFor === student.props.id))
  const password = find(tree, n => n.type === 'input' && n.props.type === 'password')
  assert.ok(find(tree, n => n.type === 'label' && n.props.htmlFor === password.props.id))
  assert.ok(find(tree, n => n.props.id === password.props['aria-describedby']))
  student.props.onChange({ target: { value: 'new-student' } })
  tree = app.render()
  find(tree, n => n.type === 'button' && n.children.includes(app.module.zh['settings.save'])).props.onClick()
  await flush()
  assert.equal(app.calls[0].buaaId, 'new-student')
  tree = app.render()
  find(tree, n => n.type === 'input' && n.props.type === 'checkbox').props.onChange({ target: { checked: false } })
  await flush()
  assert.equal(app.calls[1].enabled, false)
  tree = app.render()
  assert.equal(find(tree, n => n.type === 'input' && n.props.type === 'checkbox').props.checked, false)
})

test('gacha switches preserve game identity and errors have alert semantics', async () => {
  const app = await sourceApp('gacha', gachaState, { fail: true })
  let tree = app.render()
  find(tree, n => n.type === 'input' && n.props.type === 'checkbox').props.onChange()
  await flush()
  assert.deepEqual(app.calls[0], { op: 'setEnabled', game: 'genshin', enabled: false })
  tree = app.render()
  assert.ok(find(tree, n => n.props.role === 'alert' && n.children.includes('Request failed')))
})

test('BUAA explains automatic homework refresh and where to check in for each session state', async () => {
  for (const locale of ['zh', 'en']) {
    for (const connected of [false, true]) {
      const session = connected ? { username: 'test-student', termName: '2026 秋季' } : null
      const app = await sourceApp('buaa', { ...buaaState, spocSession: session, signinSession: session }, { locale })
      const text = nodes(app.render()).flatMap(n => n.children.filter(c => typeof c === 'string')).join(' ')
      assert.match(text, locale === 'zh' ? /30 分钟/ : /30 minutes/)
      assert.match(text, locale === 'zh' ? /同名手建待办.*截止时间/ : /matching manual tasks.*due dates/i)
      assert.match(text, locale === 'zh' ? /当天.*课程条目/ : /today.*course entries/)
    }
    const disabled = await sourceApp('buaa', { ...buaaState, spocEnabled: false }, { locale })
    const text = nodes(disabled.render()).flatMap(n => n.children.filter(c => typeof c === 'string')).join(' ')
    assert.match(text, locale === 'zh' ? /保留已有待办/ : /existing tasks are kept/i)
  }
})

test('gacha explains estimates and correction submission without remote impact details', async () => {
  for (const locale of ['zh', 'en']) {
    const app = await sourceApp('gacha', gachaState, { locale })
    const tree = app.render()
    const hint = find(tree, n => n.props.id === 'bsch-gacha-agent-hint')
    assert.ok(hint)
    assert.equal(hint.children[0], locale === 'zh'
      ? '官方时间校正会提交至数据源服务器。'
      : 'Official-time corrections are submitted to the data source server.')
    assert.doesNotMatch(hint.children[0], /所有用户|不只本机|公共|all users|shared|not just/i)
    assert.equal(find(tree, n => n.type === 'button' && n.children.includes(app.module[locale]['settings.agent'])).props['aria-describedby'], hint.props.id)
    assert.match(app.module[locale]['settings.hint'], /gacha-calendar.*≈/)
  }
})

test('source settings retain short actionable safety information without implementation jargon', async () => {
  const buaa = await sourceApp('buaa', buaaState)
  const gacha = await sourceApp('gacha', gachaState)
  assert.match(buaa.module.zh['settings.passwordHint'], /不保存/)
  assert.match(buaa.module.zh['settings.overwrite'], /替换/)
  assert.match(gacha.module.zh['settings.auto'], /关闭.*移除/)
  for (const app of [buaa, gacha]) {
    const text = nodes(app.render()).flatMap(n => n.children.filter(c => typeof c === 'string')).join(' ')
    assert.doesNotMatch(text, /内存|宿主|bundle|后台每/)
  }
})
