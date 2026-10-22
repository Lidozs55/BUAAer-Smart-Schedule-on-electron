import assert from 'node:assert/strict'
import test from 'node:test'

import { createGachaService } from '../host/service.js'

const logger = { info() {}, warn() {} }
const core = { getSourceState: () => ({}), setSourceState: async () => {} }

const serviceWith = schedule => createGachaService(
  { logger, get: name => name === 'schedule' ? schedule : undefined },
  { service: core },
)

test('weekly watch can be disabled without a session id or automation bundle', async () => {
  const service = serviceWith(undefined)
  const disabled = await service.setWatch(undefined, { enabled: false })
  assert.deepEqual(disabled, { enabled: false, reason: '已取消每周 Agent 核对。' })
  service.dispose()

  const degradedService = serviceWith(undefined)
  const degraded = await degradedService.setWatch(undefined)
  assert.equal(degraded.enabled, false)
  assert.match(degraded.reason, /自动化任务/)
  degradedService.dispose()
})

test('enabling the weekly watch requires a session id once automation is available', async () => {
  const service = serviceWith({ create: async () => ({ id: 'weekly' }), delete: async () => {} })
  await assert.rejects(
    service.setWatch(undefined),
    error => error.code === 'invalid_input' && /--session/.test(error.message),
  )
  service.dispose()
})
