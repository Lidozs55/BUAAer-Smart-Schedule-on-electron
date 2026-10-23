import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const API_ID = '@buaaer/dsh-schedule-buaa/client.api.js'
const SIGNIN_PATH = new URL('../client.signin.js', import.meta.url)

const chinaDate = (offsetDays = 0) => {
  const parts = {}
  const date = new Date(Date.now() + offsetDays * 86_400_000)
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)) parts[part.type] = part.value
  return `${parts.year}-${parts.month}-${parts.day}`
}

const entry = (overrides = {}) => ({
  id: 'entry-1',
  source: 'buaa',
  sourceKey: 'teaching:软件工程:2026-10-22:08:00',
  title: '软件工程',
  start: `${chinaDate()}T08:00:00+08:00`,
  end: `${chinaDate()}T09:40:00+08:00`,
  ...overrides,
})

const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)]
const find = (tree, predicate) => nodes(tree).find(predicate)

/** Load one browser chunk with a fake `react` and a caller-supplied API module. */
async function harness(api) {
  const modules = new Map([[API_ID, api]])
  let cursor = 0
  const slots = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
    },
  }
  modules.set('react', React)
  const window = { __ModuleLoader__: { load: ({ id, factory }) => modules.set(id, factory(id => modules.get(id))) } }
  const context = vm.createContext({ window, console, Date, Intl, setTimeout, clearTimeout })
  vm.runInContext(await readFile(SIGNIN_PATH, 'utf8'), context)
  return {
    module: modules.get('@buaaer/dsh-schedule-buaa/client.signin.js'),
    render(component, props) {
      cursor = 0
      return component(props)
    },
  }
}

test('check-in is offered only on today\'s BUAA teaching entries', async () => {
  const app = await harness({ signin: async () => ({ success: true }) })
  const { canCheckin } = app.module

  assert.equal(canCheckin(entry()), true)
  assert.equal(canCheckin(entry({ source: 'manual' })), false)
  assert.equal(canCheckin(entry({ sourceKey: 'exam:math' })), false)
  assert.equal(canCheckin(entry({ sourceKey: 'course:软件工程' })), false)
  assert.equal(canCheckin(entry({ start: `${chinaDate(-1)}T08:00:00+08:00` })), false)
  assert.equal(canCheckin(entry({ start: `${chinaDate(1)}T08:00:00+08:00` })), false)
  assert.equal(canCheckin(entry({ start: 'not-a-date' })), false)
  assert.equal(canCheckin(null), false)

  const { SigninAction } = app.module
  const t = key => key
  assert.equal(app.render(SigninAction, { t, entry: entry({ source: 'manual' }) }), null)
  assert.equal(app.render(SigninAction, { t, entry: entry({ start: `${chinaDate(-1)}T08:00:00+08:00` }) }), null)
  const today = app.render(SigninAction, { t, entry: entry() })
  assert.ok(find(today, node => node.type === 'button'))
})

test('clicking the action posts the entry id and reports the host result', async () => {
  const calls = []
  const app = await harness({
    signin: async id => {
      calls.push(id)
      return { success: true, message: '签到成功' }
    },
  })
  const { SigninAction } = app.module
  const props = { t: key => key, entry: entry() }

  let tree = app.render(SigninAction, props)
  const button = find(tree, node => node.type === 'button')
  assert.equal(button.props.disabled, false)
  assert.equal(button.children[0], 'signin.action')

  button.props.onClick()
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(calls, ['entry-1'])
  tree = app.render(SigninAction, props)
  const status = find(tree, node => node.props.role === 'status')
  assert.ok(status)
  assert.equal(status.children[0], '签到成功')
  assert.equal(find(tree, node => node.type === 'button').props.disabled, false)
})

test('busy state disables the action and failures surface as alerts', async () => {
  let reject
  const app = await harness({
    signin: () => new Promise((resolve, fail) => { reject = fail }),
  })
  const { SigninAction } = app.module
  const props = { t: key => key, entry: entry() }

  let tree = app.render(SigninAction, props)
  find(tree, node => node.type === 'button').props.onClick()
  await Promise.resolve()

  tree = app.render(SigninAction, props)
  const busyButton = find(tree, node => node.type === 'button')
  assert.equal(busyButton.props.disabled, true)
  assert.equal(busyButton.children[0], 'signin.busy')

  reject(new Error('iclass 课表中没有找到这节课'))
  await new Promise(resolve => setTimeout(resolve, 0))

  tree = app.render(SigninAction, props)
  const alert = find(tree, node => node.props.role === 'alert')
  assert.ok(alert)
  assert.equal(alert.children[0], 'iclass 课表中没有找到这节课')
  assert.equal(find(tree, node => node.type === 'button').props.disabled, false)
})
