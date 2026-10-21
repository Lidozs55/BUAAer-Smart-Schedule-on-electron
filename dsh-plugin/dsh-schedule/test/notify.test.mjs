import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'

/**
 * The notifier is a browser chunk, not an ESM export. Load it in a VM with
 * just enough `window` to capture the factory, then pin the pure formatting
 * and firing-window rules without a DOM.
 */
async function loadNotifier() {
  let api
  const window = {
    __ModuleLoader__: {
      load: ({ factory }) => { api = factory() },
    },
  }
  const source = await readFile(new URL('../client.notify.js', import.meta.url), 'utf8')
  vm.runInNewContext(source, { window, console, Date, setTimeout, clearTimeout })
  return api
}

const t = key => ({
  'notify.taskTitle': '任务提醒',
  'notify.entryTitle': '日程提醒',
  'notify.taskBody': '「{title}」将于 {time} 截止',
  'notify.entryBody': '「{title}」将于 {time} 开始{location}',
  'notify.entryAllDay': '「{title}」{date} 全天{location}',
}[key])

test('task reminder keeps the title verbatim (no $ expansion)', async () => {
  const { formatReminder } = await loadNotifier()
  const out = formatReminder({
    kind: 'task', title: 'A $& B', due: '2026-10-21T12:00:00+08:00',
  }, t)
  assert.equal(out.title, '任务提醒')
  assert.match(out.body, /A \$& B/)
  assert.match(out.body, /2026-10-21 12:00/)
})

test('ordinary entry reminders carry location verbatim', async () => {
  const { formatReminder } = await loadNotifier()
  const out = formatReminder({
    kind: 'entry', title: '学习', start: '2026-10-22T08:00:00+08:00', location: '主楼 $& 101',
  }, t)
  assert.equal(out.title, '日程提醒')
  assert.match(out.body, /主楼 \$& 101/)
  assert.match(out.body, /2026-10-22 08:00/)
})

test('entry reminders omit a missing or nullable location', async () => {
  const { formatReminder } = await loadNotifier()
  for (const location of [undefined, null, '']) {
    const out = formatReminder({
      kind: 'entry', title: 'Meeting', start: '2026-10-22T08:00:00+08:00', location,
    }, t)
    assert.equal(out.body, '「Meeting」将于 2026-10-22 08:00 开始')
  }
})

test('all-day entry shows the date, not a clock time', async () => {
  const { formatReminder } = await loadNotifier()
  const out = formatReminder({
    kind: 'entry', title: '校庆', start: '2026-10-25T00:00:00+08:00', allDay: true, location: 'Main hall',
  }, t)
  assert.match(out.body, /Main hall/)
  assert.match(out.body, /2026-10-25/)
  assert.doesNotMatch(out.body, /00:00/)
})

test('firing window is [at-60s, at+30s]', async () => {
  const { isDue } = await loadNotifier()
  const now = Date.parse('2026-10-21T12:00:00+08:00')
  const at = offset => new Date(now + offset).toISOString()
  assert.equal(isDue(at(60_000), now), true)
  assert.equal(isDue(at(30_000), now), true)
  assert.equal(isDue(at(61_000), now), false)
  assert.equal(isDue(at(-30_000), now), true)
  assert.equal(isDue(at(-31_000), now), false)
  assert.equal(isDue('not-a-date', now), false)
})
