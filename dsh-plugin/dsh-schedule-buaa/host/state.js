/**
 * Durable adapter state lives in the schedule core's opaque `sourceState`
 * map — the source plugin owns the shape, the core guarantees persistence.
 */

export const SOURCE_ID = 'buaa'

export async function saveSourceState(service, patch) {
  const next = { ...service.getSourceState(SOURCE_ID), ...patch }
  await service.setSourceState(SOURCE_ID, next)
  return next
}
