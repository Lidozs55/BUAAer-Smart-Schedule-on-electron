import assert from 'node:assert/strict'
import test from 'node:test'
import { createDropbox, DROPBOX_LIMITS } from '../host/dropbox.js'

const box = () => {
  let n = 0
  return createDropbox({
    now: () => new Date(Date.UTC(2026, 9, 22, 0, 0, n)).toISOString(),
    uuid: () => `id-${++n}`,
  })
}

const image = (data = 'cG5n') => ({ mediaType: 'image/png', data })

test('stage trims text, stores images, and only confirmed rows are deliverable', () => {
  const dropbox = box()
  assert.deepEqual(dropbox.list(), [])
  const first = dropbox.stage('  明天 14:00 交实验报告\n')
  assert.deepEqual(first, { id: 'id-1', text: '明天 14:00 交实验报告', at: '2026-10-22T00:00:01.000Z' })
  assert.equal(dropbox.stage('   '), null)
  assert.equal(dropbox.stage(42), null)
  assert.equal(dropbox.stage({ text: 'x'.repeat(DROPBOX_LIMITS.text + 1) }), null)
  const second = dropbox.stage({ images: [image()] })
  assert.deepEqual(second.images, [image()])
  assert.equal(dropbox.size, 2)

  assert.deepEqual(dropbox.listConfirmed(), [])
  assert.equal(dropbox.confirm(first.id), true)
  assert.equal(dropbox.confirm(first.id), false)
  assert.deepEqual(dropbox.listConfirmed().map(row => row.text), ['明天 14:00 交实验报告'])
  assert.equal(dropbox.ack([first.id]), 1)
  assert.deepEqual(dropbox.list().map(row => row.id), [second.id])
})

test('cancel/discard and ack remove rows', () => {
  const dropbox = box()
  const first = dropbox.stage('一')
  const second = dropbox.stage('二')
  assert.equal(dropbox.discard(first.id), true)
  assert.equal(dropbox.discard(first.id), false)
  dropbox.confirm(second.id)
  assert.equal(dropbox.ack(undefined), 0)
  assert.equal(dropbox.ack([second.id, 'missing']), 1)
  assert.equal(dropbox.size, 0)
})

test('the inbox is bounded; oldest rows fall off first', () => {
  const dropbox = box()
  for (let i = 0; i < DROPBOX_LIMITS.entries + 2; i += 1) dropbox.stage(`第 ${i} 段`)
  const texts = dropbox.list().map(row => row.text)
  assert.equal(texts.length, DROPBOX_LIMITS.entries)
  assert.equal(texts[0], '第 2 段')
  assert.equal(texts.at(-1), '第 11 段')
})

test('list/listConfirmed return copies, so callers cannot mutate the inbox', () => {
  const dropbox = box()
  const staged = dropbox.stage({ text: '原始', images: [image()] })
  const peeked = dropbox.list()
  peeked[0].text = '改掉'
  peeked[0].images[0].data = 'bogus'
  assert.equal(dropbox.list()[0].text, '原始')
  assert.equal(dropbox.list()[0].images[0].data, 'cG5n')

  dropbox.confirm(staged.id)
  const confirmed = dropbox.listConfirmed()
  confirmed[0].text = '改掉'
  assert.equal(dropbox.listConfirmed()[0].text, '原始')
})

test('invalid image collections are rejected whole', () => {
  const dropbox = box()
  assert.equal(dropbox.stage({ images: [] }), null)
  assert.equal(dropbox.stage({ images: [{ mediaType: 'image/svg+xml', data: 'cG5n' }] }), null)
  assert.equal(dropbox.stage({ images: [{ mediaType: 'image/png', data: '' }] }), null)
  assert.equal(dropbox.stage({
    images: Array.from({ length: DROPBOX_LIMITS.images + 1 }, () => image()),
  }), null)
})

test('unanswered pending rows expire; confirmed rows do not', () => {
  let clock = '2026-10-22T00:00:00.000Z'
  let n = 0
  const dropbox = createDropbox({ now: () => clock, uuid: () => `id-${++n}` })
  const pending = dropbox.stage('悬而未决')
  const confirmed = dropbox.stage('已确认')
  dropbox.confirm(confirmed.id)
  clock = new Date(Date.parse(clock) + DROPBOX_LIMITS.pendingMs + 1).toISOString()
  assert.deepEqual(dropbox.list().map(row => row.id), [confirmed.id])
  assert.equal(dropbox.confirm(pending.id), false)
})

test('ack with a sessionId announces the hand-off; without one it stays silent', () => {
  const dropbox = box()
  const delivered = []
  const off = dropbox.onDelivered(sessionId => delivered.push(sessionId))
  const row = dropbox.stage('交给会话')
  dropbox.confirm(row.id)

  assert.equal(dropbox.ack([row.id]), 1, 'ack still removes the row without a session')
  assert.deepEqual(delivered, [])

  const second = dropbox.stage('再交一个')
  dropbox.confirm(second.id)
  assert.equal(dropbox.ack([second.id], 'sess-9'), 1)
  assert.deepEqual(delivered, ['sess-9'])

  // No row removed ⇒ no announcement, even with a sessionId.
  assert.equal(dropbox.ack(['missing'], 'sess-10'), 0)
  assert.deepEqual(delivered, ['sess-9'])

  off()
  const third = dropbox.stage('无人监听')
  dropbox.confirm(third.id)
  dropbox.ack([third.id], 'sess-11')
  assert.deepEqual(delivered, ['sess-9'])
})

test('a throwing onDelivered listener cannot break the ack', () => {
  const dropbox = box()
  const heard = []
  dropbox.onDelivered(() => { throw new Error('listener gone') })
  dropbox.onDelivered(sessionId => heard.push(sessionId))
  const row = dropbox.stage('隔离')
  dropbox.confirm(row.id)
  assert.equal(dropbox.ack([row.id], 'sess-1'), 1)
  assert.deepEqual(heard, ['sess-1'])
  assert.deepEqual(dropbox.list(), [])
})
