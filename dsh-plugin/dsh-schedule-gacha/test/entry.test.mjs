import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')

test('host bundle declares every context service it reads directly', () => {
  const declared = /export const inject = \[([^\]]*)\]/.exec(source)?.[1] ?? ''
  for (const name of ['scheduleCore', 'connection', 'scheduleCommands', 'timer']) {
    assert.ok(declared.includes(`'${name}'`), `inject is missing ${name}`)
  }
  // Regression: reading `ctx.timer` without declaring it makes the whole
  // bundle fail activation with `cannot get property "timer" without inject`.
  assert.match(source, /ctx\.timer/)
})
