import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

async function harness() {
  const modules = new Map(), listeners = new Map()
  let slots = [], cursor = 0, effects = []
  const depsEqual = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]))
  const React = {
    Fragment: Symbol.for('react.fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }] },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial } },
    useMemo(fn, deps) { const i = cursor++; if (!depsEqual(slots[i]?.deps, deps)) slots[i] = { value: fn(), deps }; return slots[i].value },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps) },
    useEffect(fn, deps) { const i = cursor++; if (!depsEqual(slots[i]?.deps, deps)) { const prev = slots[i]; slots[i] = { deps }; effects.push(() => { prev?.cleanup?.(); slots[i].cleanup = fn() }) } },
  }
  modules.set('react', React)
  const window = { addEventListener(k, fn) { if (!listeners.has(k)) listeners.set(k, new Set()); listeners.get(k).add(fn) }, removeEventListener(k, fn) { listeners.get(k)?.delete(fn) }, dispatchEvent(event) { for (const fn of listeners.get(event.type) ?? []) fn(event) }, __ModuleLoader__: { load({ id, factory }) { modules.set(id, factory(id => modules.get(id))) } } }
  const context = vm.createContext({ window, console, Date, setTimeout, clearTimeout, CustomEvent: class { constructor(type) { this.type = type } }, globalThis: { crypto: { randomUUID: () => 'new-id' } } })
  for (const name of ['core', 'notify', 'settings']) vm.runInContext(await readFile(new URL(`../client.${name}.js`, import.meta.url), 'utf8'), context)
  return { dispatch(type) { window.dispatchEvent({ type }) }, module: n => modules.get(`@lidozs55/dsh-schedule/client.${n}.js`), render(fn, props) { cursor = 0; const tree = fn(props); const queued = effects; effects = []; queued.forEach(run => run()); return tree } }
}
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...(tree.children ?? []).flatMap(nodes)]
const find = (tree, pred) => nodes(tree).find(pred)
const categories = [
  { id: 'course', name: '课程', color: '#3B82F6' }, { id: 'exam', name: '考试', color: '#EF4444' }, { id: 'other', name: '其它', color: '#64748B' },
]
const t = key => key
const propsWith = api => ({ t, env: { api }, renderSlot: () => null })
const snapshotApi = (snapshot, setCategories = async cats => ({ categories: cats })) => ({ snapshot: async () => ({ global: { termStart: '', categories: snapshot } }), setMeta: async patch => ({ ...patch }), setCategories })

test('configured palette drives preview and editor settings; save category changes and native palette input', async () => {
  const app = await harness(), Settings = app.module('settings').SettingsSection
  let saved
  const api = snapshotApi(categories, async rows => { saved = rows; return { categories: rows } })
  let tree = app.render(Settings, propsWith(api))
  await new Promise(resolve => setImmediate(resolve))
  tree = app.render(Settings, propsWith(api))
  const color = find(tree, n => n.type === 'input' && n.props.type === 'color' && n.props['aria-label'].startsWith('课程'))
  assert.equal(color.props.value, '#3B82F6')
  color.props.onChange({ target: { value: '#00FF88' } })
  tree = app.render(Settings, propsWith(api))
  const previewElement = find(tree, n => n.props.category === 'course' && n.props.categories)
  const preview = previewElement.type(previewElement.props)
  assert.equal(preview.props.style['--bsch-block-color'], '#00FF88')
  assert.ok(preview)
  find(tree, n => n.type === 'button' && n.children.includes('settings.saveCategories')).props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(saved[0].color, '#00FF88')
})

test('category add, rename and delete draft protects other and confirms reassignment semantics', async () => {
  const app = await harness(), Settings = app.module('settings').SettingsSection
  const api = snapshotApi(categories)
  let tree = app.render(Settings, propsWith(api))
  await new Promise(resolve => setImmediate(resolve))
  tree = app.render(Settings, propsWith(api))
  find(tree, n => n.type === 'button' && n.children.includes('settings.addCategory')).props.onClick()
  tree = app.render(Settings, propsWith(api))
  assert.ok(find(tree, n => n.props['data-category-id'] === 'custom-new-id'))
  const otherRow = find(tree, n => n.props['data-category-id'] === 'other')
  assert.equal(find(otherRow, n => n.type === 'button').props.disabled, true)
  const newRow = find(tree, n => n.props['data-category-id'] === 'custom-new-id')
  find(newRow, n => n.type === 'input' && n.props.className.includes('bsch-category-name')).props.onChange({ target: { value: 'My category' } })
  tree = app.render(Settings, propsWith(api))
  assert.ok(find(tree, n => n.type === 'input' && n.props.value === 'My category'))
  const deleteButton = find(tree, n => n.type === 'button' && n.props['aria-label'] === 'entry.delete 课程')
  deleteButton.props.onClick()
  tree = app.render(Settings, propsWith(api))
  const confirm = find(tree, n => n.props.message === 'settings.deleteCategoryHint')
  confirm.props.onConfirm()
  tree = app.render(Settings, propsWith(api))
  assert.equal(find(tree, n => n.props['data-category-id'] === 'course'), undefined)
})

test('failed category save preserves draft and exposes actionable error', async () => {
  const app = await harness(), Settings = app.module('settings').SettingsSection
  const api = snapshotApi(categories, async () => { throw new Error('write denied') })
  let tree = app.render(Settings, propsWith(api))
  await new Promise(resolve => setImmediate(resolve))
  tree = app.render(Settings, propsWith(api))
  find(tree, n => n.type === 'input' && n.props.type === 'color').props.onChange({ target: { value: '#123456' } })
  tree = app.render(Settings, propsWith(api))
  find(tree, n => n.type === 'button' && n.children.includes('settings.saveCategories')).props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  tree = app.render(Settings, propsWith(api))
  assert.ok(find(tree, n => n.props.role === 'alert' && n.children.includes('write denied')))
  assert.ok(find(tree, n => n.type === 'input' && n.props.type === 'color' && n.props.value === '#123456'))
})


test('source pulses and term save cannot overwrite an unsaved category draft', async () => {
  const app = await harness(), Settings = app.module('settings').SettingsSection
  const api = snapshotApi(categories)
  let tree = app.render(Settings, propsWith(api))
  await new Promise(resolve => setImmediate(resolve))
  tree = app.render(Settings, propsWith(api))
  find(tree, n => n.type === 'input' && n.props.type === 'color').props.onChange({ target: { value: '#778899' } })
  app.dispatch('schedule:data-changed')
  await new Promise(resolve => setImmediate(resolve))
  tree = app.render(Settings, propsWith(api))
  find(tree, n => n.type === 'button' && n.children.includes('entry.save')).props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  tree = app.render(Settings, propsWith(api))
  assert.ok(find(tree, n => n.type === 'input' && n.props.type === 'color' && n.props.value === '#778899'))
})

test('import with exportedAt refreshes category metadata', async () => {
  const app = await harness(), Settings = app.module('settings').SettingsSection
  let current = categories, payload, calls = 0
  const api = { snapshot: async () => { calls++; return { global: { termStart: '', categories: current } } },
    importData: async value => { payload = value; current = [{ id: 'other', name: '其它', color: '#AABBCC' }]; return { entries: { created: 1, skipped: 0 }, tasks: { created: 0, skipped: 0 } } } }
  let tree = app.render(Settings, propsWith(api))
  await new Promise(resolve => setImmediate(resolve))
  tree = app.render(Settings, propsWith(api))
  const upload = find(tree, n => n.type === 'input' && n.props.type === 'file')
  upload.props.onChange({ target: { files: [{ text: async () => JSON.stringify({ exportedAt: '2026-10-21T00:00:00Z', entries: [] }) }], value: 'backup.json' } })
  await new Promise(resolve => setImmediate(resolve))
  tree = app.render(Settings, propsWith(api))
  assert.equal(payload.exportedAt, '2026-10-21T00:00:00Z')
  assert.ok(calls >= 2)
  assert.ok(find(tree, n => n.type === 'input' && n.props.type === 'color' && n.props.value === '#AABBCC'))
})

test('settings omit read-only notification status and never query browser permission', async () => {
  const app = await harness(), Settings = app.module('settings').SettingsSection
  app.module('notify').notificationStatus = () => { throw new Error('Settings must not query notification permission') }
  const tree = app.render(Settings, propsWith(snapshotApi(categories)))
  assert.equal(find(tree, n => n.props['aria-labelledby'] === 'bsch-notify-heading'), undefined)
  assert.equal(find(tree, n => n.children.some(c => typeof c === 'string' && c.startsWith('settings.notify'))), undefined)
})

test('core settings share semantic section headings and an explicitly labelled term field', async () => {
  const app = await harness(), Settings = app.module('settings').SettingsSection
  const api = snapshotApi(categories)
  let tree = app.render(Settings, propsWith(api))
  await new Promise(resolve => setImmediate(resolve))
  tree = app.render(Settings, propsWith(api))
  const sections = nodes(tree).filter(n => n.type === 'section')
  assert.equal(sections.length, 3)
  for (const section of sections) {
    assert.ok(section.props.className.includes('bsch-settings-section'))
    const heading = find(section, n => n.type === 'h3')
    assert.equal(heading.props.className, 'bsch-settings-heading')
    assert.equal(heading.props.id, section.props['aria-labelledby'])
  }
  const term = find(tree, n => n.type === 'input' && n.props.type === 'date')
  assert.ok(find(tree, n => n.type === 'label' && n.props.htmlFor === term.props.id))
  assert.ok(find(tree, n => n.props.id === term.props['aria-describedby']))
})

test('backup settings explain merge rules and excluded source settings in both languages', async () => {
  const app = await harness(), Settings = app.module('settings').SettingsSection
  for (const locale of ['zh', 'en']) {
    const translations = app.module('core')[locale]
    const tree = app.render(Settings, { ...propsWith(snapshotApi(categories)), t: key => translations[key] ?? key })
    const hint = find(tree, n => n.props.id === 'bsch-backup-hint')
    assert.ok(hint)
    assert.equal(hint.children[0], translations['settings.backupHint'])
    assert.match(hint.children[0], locale === 'zh' ? /合并.*跳过.*不含.*来源设置/ : /merge.*skip.*exclude.*source settings/i)
    assert.match(translations['settings.clearAllHint'], locale === 'zh' ? /同步仍会.*重新生成/ : /sync.*recreate/i)
    for (const key of ['settings.export', 'settings.import']) {
      assert.equal(find(tree, n => n.type === 'button' && n.children.includes(translations[key])).props['aria-describedby'], hint.props.id)
    }
  }
})

test('backup import uses a keyboard-accessible button and clearing still requires confirmation', async () => {
  const app = await harness(), Settings = app.module('settings').SettingsSection
  let picked = 0, cleared = 0
  const api = { ...snapshotApi(categories), clearAllData: async () => { cleared++; return { deleted: 0 } } }
  let tree = app.render(Settings, propsWith(api))
  await new Promise(resolve => setImmediate(resolve))
  tree = app.render(Settings, propsWith(api))
  const upload = find(tree, n => n.type === 'input' && n.props.type === 'file')
  assert.equal(upload.props.hidden, true)
  upload.props.ref.current = { click() { picked++ } }
  find(tree, n => n.type === 'button' && n.children.includes('settings.import')).props.onClick()
  assert.equal(picked, 1)
  const danger = find(tree, n => n.props.className === 'bsch-settings-danger')
  const copy = find(danger, n => n.props.className === 'bsch-settings-danger-copy')
  const clear = find(danger, n => n.type === 'button' && n.children.includes('settings.clearAllConfirm'))
  assert.ok(copy)
  assert.ok(danger.children.includes(copy) && danger.children.includes(clear), 'copy and action are siblings, not a form row')
  assert.ok(find(copy, n => n.props.id === clear.props['aria-describedby']))
  clear.props.onClick()
  assert.equal(cleared, 0)
  tree = app.render(Settings, propsWith(api))
  const dialog = find(tree, n => n.props.confirmLabel === 'settings.clearAllConfirm')
  assert.equal(dialog.props.message, 'settings.clearAllHint')
  dialog.props.onConfirm()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cleared, 1)
})
