import assert from 'node:assert/strict'
import test from 'node:test'
import { createCommandRegistry } from '../../dsh-schedule/host/command-registry.js'
import { registerGachaCommands } from '../host/commands.js'

function fixture() {
  const calls = []
  const service = {
    calendarApi: {
      async posts(input) {
        calls.push(input)
        return { data: [{ id: 'post-1', title: '版本更新公告' }], pagination: { page: input.page } }
      },
    },
  }
  const registry = createCommandRegistry()
  registerGachaCommands(registry, service)
  return { calls, registry }
}

test('gacha posts forwards filters and returns the raw service page', async () => {
  const { calls, registry } = fixture()
  const value = await registry.execute(['gacha', 'posts'], {
    game: 'genshin',
    page: 2,
    'page-size': 5,
    type: 'article',
  }, {})
  assert.deepEqual(calls[0], { gameId: 'genshin', page: 2, pageSize: 5, type: 'article' })
  assert.equal(value.data[0].id, 'post-1')
  assert.equal(value.pagination.page, 2)
})

test('gacha posts validates page bounds and is discoverable in help', async () => {
  const { registry } = fixture()
  const catalog = registry.catalog()
  const gacha = catalog.commands.find(command => command.name === 'gacha')
  assert.ok(gacha.children.some(child => child.name === 'posts'))
  await assert.rejects(
    registry.execute(['gacha', 'posts'], { 'page-size': 101 }, {}),
    error => error.code === 'invalid_input' && /page-size/.test(error.message),
  )
  await assert.rejects(
    registry.execute(['gacha', 'posts'], { page: 0 }, {}),
    error => error.code === 'invalid_input' && /page/.test(error.message),
  )
})
