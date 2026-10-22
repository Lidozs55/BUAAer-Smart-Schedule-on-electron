import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

async function harness() {
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
    useEffect() {},
  }
  modules.set('react', React)
  const window = { __ModuleLoader__: { load: ({ id, factory }) => modules.set(id, factory(id => modules.get(id))) } }
  const context = vm.createContext({ window, console, Date, setTimeout, clearTimeout })
  for (const name of ['core', 'gridmath', 'editors', 'tasks']) {
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
const find = (tree, predicate) => nodes(tree).find(predicate)
const titles = tree => nodes(tree)
  .filter(node => node.props?.className === 'bsch-row-title')
  .map(node => node.children.join(''))

const task = (id, priority, completed = false) => ({
  id, title: id, priority, completed, taskType: 'homework', description: null,
  due: new Date(Date.now() + 3_600_000).toISOString(),
})

test('priority filter narrows task rows and combines with status filter', async () => {
  const client = await harness()
  const { TasksTab } = client.module('tasks')
  const props = {
    t: key => key,
    api: { setTaskCompleted: async () => {} },
    refresh: async () => {},
    today: new Date().toISOString().slice(0, 10),
    tasks: [
      task('high pending', 'high'),
      task('medium pending', 'medium'),
      task('low pending', 'low'),
      task('high done', 'high', true),
    ],
  }
  const select = (tree, label) => find(tree, node => node.type === 'select' && node.props['aria-label'] === label)
  let tree = client.render(TasksTab, props)
  const priority = select(tree, 'task.priority')
  assert.deepEqual(priority.children.map(option => option.props.value), ['all', 'high', 'medium', 'low'])
  assert.deepEqual(new Set(titles(tree)), new Set(['high pending', 'medium pending', 'low pending', 'high done']))

  priority.props.onChange({ target: { value: 'high' } })
  tree = client.render(TasksTab, props)
  assert.deepEqual(new Set(titles(tree)), new Set(['high pending', 'high done']))

  assert.equal(select(tree, 'task.filter').props.value, 'all')
  select(tree, 'task.filter').props.onChange({ target: { value: 'pending' } })
  tree = client.render(TasksTab, props)
  assert.deepEqual(titles(tree), ['high pending'])

  assert.equal(select(tree, 'task.filter').props.value, 'pending')
  select(tree, 'task.filter').props.onChange({ target: { value: 'done' } })
  tree = client.render(TasksTab, props)
  assert.deepEqual(titles(tree), ['high done'])
})
