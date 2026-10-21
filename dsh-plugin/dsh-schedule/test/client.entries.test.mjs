import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

// Execute the browser chunks and their handlers without requiring the host app.
async function clientHarness() {
  const modules = new Map()
  const listeners = new Map()
  let slots = [], cursor = 0, effects = []
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
    useEffect(effect, deps) {
      const index = cursor++
      if (!sameDeps(slots[index]?.deps, deps)) {
        const previous = slots[index]
        slots[index] = { deps }
        effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = effect() })
      }
    },
  }
  modules.set('react', React)
  const window = {
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(handler)
    },
    removeEventListener: (type, handler) => listeners.get(type)?.delete(handler),
    __ModuleLoader__: { load: ({ id, factory }) => modules.set(id, factory(id => modules.get(id))) },
  }
  const context = vm.createContext({ window, console, Date, setTimeout, clearTimeout })
  for (const file of ['core', 'gridmath', 'editors', 'weekgrid', 'notify']) {
    vm.runInContext(await readFile(new URL(`../client.${file}.js`, import.meta.url), 'utf8'), context)
  }
  return {
    module: name => modules.get(`@lidozs55/dsh-schedule/client.${name}.js`),
    render(component, props) {
      cursor = 0
      const tree = component(props)
      const pending = effects; effects = []
      for (const effect of pending) effect()
      return tree
    },
    dispatch(type, event) { for (const handler of [...(listeners.get(type) ?? [])]) handler(event) },
    listenerCount: type => listeners.get(type)?.size ?? 0,
  }
}

const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...tree.children.flatMap(nodes)]
const find = (tree, predicate) => nodes(tree).find(predicate)
const control = (tree, label) => {
  if (label === 'entry.lock') return find(tree, node => node.props.role === 'switch')
  const field = find(tree, node => node.props.className === 'bsch-field' && node.children[0]?.children[0] === label)
  assert.ok(field, `missing field ${label}`)
  return field.children[1]
}
const button = (tree, label) => {
  const result = find(tree, node => node.type === 'button' && node.children.includes(label))
  assert.ok(result, `missing button ${label}`)
  return result
}
const settle = () => new Promise(resolve => setImmediate(resolve))
const entry = (id, lock = false) => ({
  id, title: `Entry ${id}`, category: 'study', location: 'Room 101', lock,
  start: new Date(2026, 9, 21, 9).toISOString(), end: new Date(2026, 9, 21, 10).toISOString(), description: 'Notes',
})

test('generic client bootstraps seven categories without occurrence APIs/editor', async () => {
  const client = await clientHarness()
  const core = client.module('core')
  assert.deepEqual(Array.from(core.DEFAULT_CATEGORIES, category => category.id), ['course', 'homework', 'exam', 'meeting', 'study', 'sports', 'other'])
   assert.equal(core.categoryColor('course'), '#3B82F6')
  assert.equal(core.zh['cat.study'], '学习')
  assert.equal(core.createApi(() => {}).saveCourseOccurrence, undefined)
  assert.equal(core.createApi(() => {}).resetCourseOccurrence, undefined)
  assert.equal(client.module('editors').CourseEditor, undefined)
  for (const dictionary of [core.zh, core.en]) {
    assert.equal(Object.keys(dictionary).some(key => /classTitle|classBody/.test(key)), false)
  }
})

test('entry creation defaults unlocked and submits location/lock from shared controls', async () => {
  const client = await clientHarness()
  const { EventEditor } = client.module('editors')
  const inputs = []
  const props = { t: key => key, initial: null, draft: entry('draft'),
    api: { createEntry: async input => { inputs.push(input); return { id: 'created' } } },
    onClose() {}, onSaved() {},
  }
  let tree = client.render(EventEditor, props)
  assert.equal(control(tree, 'entry.lock').props['aria-checked'], false)
  control(tree, 'entry.title').props.onChange({ target: { value: 'New entry' } })
  control(tree, 'entry.location').props.onChange({ target: { value: 'Library' } })
  control(tree, 'entry.lock').props.onClick()
  tree = client.render(EventEditor, props)
  button(tree, 'entry.save').props.onClick()
  await settle()
  assert.equal(inputs[0].location, 'Library')
  assert.equal(inputs[0].lock, true)
})

test('entry edit undo restores nullable location and lock, clearing location sends null', async () => {
  const client = await clientHarness()
  const { EventEditor } = client.module('editors')
  const updates = [], undo = []
  const initial = entry('locked', true)
  const props = { t: key => key, initial,
    api: { updateEntry: async (id, patch) => { updates.push({ id, patch }); return { id } } },
    undoApi: { push: item => undo.push(item) }, refresh: async () => {}, onClose() {}, onSaved() {},
  }
  let tree = client.render(EventEditor, props)
  assert.equal(control(tree, 'entry.location').props.value, initial.location)
  assert.equal(control(tree, 'entry.lock').props['aria-checked'], true)
  control(tree, 'entry.location').props.onChange({ target: { value: '' } })
  control(tree, 'entry.lock').props.onClick()
  tree = client.render(EventEditor, props)
  button(tree, 'entry.save').props.onClick()
  await settle()
  assert.equal(updates[0].patch.location, null)
  assert.equal(updates[0].patch.lock, false)
  await undo[0].undo()
  assert.equal(updates[1].patch.location, initial.location)
  assert.equal(updates[1].patch.lock, true)
  await undo[0].redo()
  assert.equal(updates[2].patch.location, null)
  assert.equal(updates[2].patch.lock, false)
})

test('locked entries remain deletable and delete undo preserves location and lock', async () => {
  const client = await clientHarness()
  const { EventEditor } = client.module('editors')
  const created = [], deleted = [], undo = []
  const props = { t: key => key, initial: { ...entry('locked', true), source: 'buaa', sourceKey: 'teaching:math:2026-10-21:08:00', allDay: true },
    api: {
      deleteEntry: async id => deleted.push(id),
      createEntry: async input => { created.push(input); return { id: 'recreated' } },
    },
    undoApi: { push: item => undo.push(item) }, refresh: async () => {}, onClose() {}, onSaved() {},
  }
  let tree = client.render(EventEditor, props)
  button(tree, 'entry.delete').props.onClick()
  tree = client.render(EventEditor, props)
  tree.props.onConfirm()
  await settle()
  assert.equal(deleted[0], 'locked')
  await undo[0].undo()
  assert.equal(created[0].location, 'Room 101')
  assert.equal(created[0].lock, true)
  assert.equal(created[0].source, 'buaa')
  assert.equal(created[0].sourceKey, props.initial.sourceKey)
  assert.equal(created[0].allDay, true)
  await undo[0].redo()
  assert.equal(deleted[1], 'recreated')
})

test('batch creation exposes shared location and lock controls', async () => {
  const client = await clientHarness()
  const { BatchEditor } = client.module('editors')
  let inputs
  const props = { t: key => key,
    api: { batchCreateEntries: async rows => { inputs = rows; return rows.map((_, i) => ({ ok: true, id: String(i) })) } },
    refresh: async () => {}, onClose() {},
  }
  let tree = client.render(BatchEditor, props)
  assert.equal(control(tree, 'entry.lock').props['aria-checked'], false)
  control(tree, 'entry.title').props.onChange({ target: { value: 'Batch' } })
  control(tree, 'entry.location').props.onChange({ target: { value: 'Gym' } })
  control(tree, 'entry.lock').props.onClick()
  tree = client.render(BatchEditor, props)
  button(tree, 'batch.create').props.onClick()
  await settle()
  assert.ok(inputs.length > 1)
  assert.ok(inputs.every(row => row.location === 'Gym' && row.lock === true))
})

async function gridHarness(rows) {
  const client = await clientHarness()
  const { WeekGrid } = client.module('weekgrid')
  const moved = [], edited = [], deleted = [], drafts = []
  const props = { t: key => key, weekStart: '2026-10-21', entries: rows, completedTaskIds: [],
    onEditEntry: block => edited.push(block.raw), onDeleteEntries: blocks => deleted.push(blocks),
    onMoveItems: async items => { moved.push(items); return {} },
    onCreateAt: (...args) => drafts.push(args), onJumpTo() {},
  }
  const element = id => ({ dataset: { kind: 'entry', entryId: id }, classList: { contains: () => false },
    getBoundingClientRect: () => ({ left: 0, right: 100, top: 200, bottom: 260 }),
  })
  let tree
  const render = () => {
    tree = client.render(WeekGrid, props)
    const grid = find(tree, node => node.props.className === 'bsch-grid')
    grid.props.ref.current = {
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 700, height: 1440 }),
      querySelectorAll: selector => selector === '.bsch-daycell'
        ? Array.from({ length: 7 }, (_, i) => ({ getBoundingClientRect: () => ({ left: i * 100, right: (i + 1) * 100, width: 100 }) }))
        : rows.map(row => element(row.id)),
    }
    return grid
  }
  render()
  return { ...client, moved, edited, deleted, drafts, render,
    blocks: () => nodes(tree).filter(node => typeof node.type === 'function' && node.props.block),
    pointer(id, button = 0, y = 210) {
      render().props.onPointerDown({ button, clientX: 50, clientY: y, preventDefault() {},
        target: { closest: selector => selector === '.bsch-block' && id ? element(id) : null },
      })
    },
    doubleClick(id) {
      render().props.onDoubleClick({ target: { closest: selector => selector === '.bsch-block' ? element(id) : null } })
    },
  }
}

test('all grid entries share title/location details; locked rows refuse quick dragging only', async () => {
  const grid = await gridHarness([entry('locked', true)])
  const block = grid.blocks()[0]
  assert.equal(block.props.block.subtitle, 'Room 101')
  const rendered = block.type(block.props)
  assert.equal(find(rendered, node => node.props.className === 'bsch-block-resize'), undefined)
  grid.pointer('locked')
  grid.dispatch('pointermove', { clientX: 50, clientY: 270 })
  grid.dispatch('pointerup', { clientX: 50, clientY: 270 })
  await settle()
  assert.equal(grid.moved.length, 0)
  assert.equal(grid.listenerCount('pointermove'), 0)
  grid.doubleClick('locked')
  grid.pointer('locked', 2)
  grid.dispatch('pointerup', { clientX: 50, clientY: 210 })
  assert.equal(grid.edited.length, 2)
  assert.equal(grid.drafts.length, 0)
  grid.render()
  grid.dispatch('keydown', { key: 'Delete', target: { closest: () => null } })
  assert.equal(grid.deleted[0][0].id, 'locked')
})

test('selection drag excludes locked rows but Delete still includes them', async () => {
  const grid = await gridHarness([entry('open'), entry('locked', true)])
  // Marquee selects both blocks, then a press on the unlocked block moves only it.
  grid.pointer(null, 0, 100)
  grid.dispatch('pointermove', { clientX: 150, clientY: 300 })
  grid.dispatch('pointerup', { clientX: 150, clientY: 300 })
  grid.pointer('open')
  grid.dispatch('pointermove', { clientX: 50, clientY: 270 })
  grid.dispatch('pointerup', { clientX: 50, clientY: 270 })
  await settle()
  assert.equal(grid.moved.length, 1)
  assert.deepEqual(Array.from(grid.moved[0], row => row.id), ['open'])
  grid.render()
  grid.dispatch('keydown', { key: 'Delete', target: { closest: () => null } })
  assert.deepEqual(Array.from(grid.deleted[0], row => row.id).sort(), ['locked', 'open'])
})

test('right-clicking a resize edge opens the editor instead of resizing', async () => {
  const grid = await gridHarness([entry('open')])
  const block = grid.blocks()[0]
  const handle = find(block.type(block.props), node => node.props.className === 'bsch-block-resize')
  const element = { dataset: { kind: 'entry', entryId: 'open' }, classList: { contains: () => false } }
  let stopped = false
  const event = { button: 2, clientX: 50, clientY: 260, preventDefault() {},
    stopPropagation() { stopped = true },
    target: { closest: selector => selector === '.bsch-block' ? element : handle },
  }
  handle.props.onPointerDown(event)
  assert.equal(stopped, false)
  grid.render().props.onPointerDown(event)
  grid.dispatch('pointerup', { clientX: 50, clientY: 260 })
  assert.equal(grid.edited[0].id, 'open')
  assert.equal(grid.moved.length, 0)
})

test('unlocked resize still changes duration', async () => {
  const grid = await gridHarness([entry('open')])
  const block = grid.blocks()[0]
  const handle = find(block.type(block.props), node => node.props.className === 'bsch-block-resize')
  assert.ok(handle)
  handle.props.onPointerDown({ button: 0, clientY: 200, preventDefault() {}, stopPropagation() {} })
  grid.dispatch('pointerup', { clientY: 230 })
  await settle()
  assert.equal(grid.moved.length, 1)
  assert.equal(Date.parse(grid.moved[0][0].after.end) - Date.parse(grid.moved[0][0].before.end), 30 * 60_000)
})


test('dynamic category options, immediate preview and deleted-category save fallback', async () => {
  const client = await clientHarness()
  const { EventEditor } = client.module('editors')
  const { CategoryPreview } = client.module('core')
  const categories = [{ id: 'custom-design', name: '设计', color: '#DA22AA' }, { id: 'other', name: '其它', color: '#64748B' }]
  let saved
  const props = { t: key => key, initial: { ...entry('design'), category: 'custom-design' }, categories,
    api: { updateEntry: async (_, input) => { saved = input; return { id: 'design' } } }, onClose() {}, onSaved() {} }
  let tree = client.render(EventEditor, props)
  assert.deepEqual(Array.from(control(tree, 'entry.category').children, node => node.props.value), ['custom-design', 'other'])
  let preview = find(tree, node => node.type === CategoryPreview)
  assert.equal(preview.type(preview.props).props.style['--bsch-block-color'], '#DA22AA')
  props.categories = [{ ...categories[1], color: '#112233' }]
  tree = client.render(EventEditor, props)
  assert.equal(control(tree, 'entry.category').props.value, 'other')
  preview = find(tree, node => node.type === CategoryPreview)
  assert.equal(preview.type(preview.props).props.style['--bsch-block-color'], '#112233')
  button(tree, 'entry.save').props.onClick()
  await settle()
  assert.equal(saved.category, 'other')
})

test('lock switch supports keyboard activation without changing drag-only semantics', async () => {
  const client = await clientHarness()
  const { EventEditor } = client.module('editors')
  const props = { t: key => key, initial: null, onClose() {}, onSaved() {}, api: {} }
  let tree = client.render(EventEditor, props)
  const toggle = () => control(tree, 'entry.lock')
  assert.equal(toggle().type, 'button')
  assert.equal(toggle().props.role, 'switch')
  let prevented = false
  toggle().props.onKeyDown({ key: ' ', preventDefault() { prevented = true } })
  tree = client.render(EventEditor, props)
  assert.equal(prevented, true)
  assert.equal(toggle().props['aria-checked'], true)
  toggle().props.onKeyDown({ key: 'Enter', preventDefault() {} })
  tree = client.render(EventEditor, props)
  assert.equal(toggle().props['aria-checked'], false)
  toggle().props.onClick()
  tree = client.render(EventEditor, props)
  assert.equal(toggle().props['aria-checked'], true)
})

test('grid category color updates use configured colors, not static tokens', async () => {
  const grid = await gridHarness([{ ...entry('custom'), category: 'custom-art' }])
  const block = grid.blocks()[0]
  const categories = [{ id: 'custom-art', name: '绘画', color: '#FC2288' }, { id: 'other', name: '其它', color: '#64748B' }]
  assert.equal(block.type({ ...block.props, categories }).props.style['--bsch-block-color'], '#FC2288')
  categories[0].color = '#22AADD'
  assert.equal(block.type({ ...block.props, categories }).props.style['--bsch-block-color'], '#22AADD')
})

test('undo restore resolves removed category to current other color metadata', async () => {
  const client = await clientHarness()
  const restored = await client.module('core').currentCategoryInputs({ snapshot: async () => ({ global: { categories: [{ id: 'other', name: '其它', color: '#112233' }] } }) }, [{ category: 'study', lock: true, location: 'A' }])
  assert.equal(restored[0].category, 'other')
  assert.equal(restored[0].lock, true)
  assert.equal(restored[0].location, 'A')
})

test('category API posts explicit full-list operation', async () => {
  const client = await clientHarness()
  let body
  const api = client.module('core').createApi(async (_, options) => { body = JSON.parse(options.body); return { json: async () => ({ ok: true, value: { categories: [] } }) } })
  await api.setCategories([{ id: 'other', name: '其它', color: '#64748B' }])
  assert.equal(body.op, 'setCategories')
  assert.equal(body.categories[0].id, 'other')
})


test('undo errors stay visible and retain the actionable stack entry', async () => {
  const client = await clientHarness()
  const { useUndo } = client.module('core')
  const refresh = async () => {}
  let undo = client.render(useUndo, refresh)
  undo.push({ undo: async () => { throw new Error('Category was removed; choose Other and retry.') } })
  undo = client.render(useUndo, refresh)
  undo.undo()
  await settle()
  undo = client.render(useUndo, refresh)
  assert.match(undo.error, /choose Other/)
  assert.equal(undo.canUndo, true)
})
