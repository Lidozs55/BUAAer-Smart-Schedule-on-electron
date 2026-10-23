/**
 * Ephemeral host-side inbox for content dropped on the pet.
 *
 * This is deliberately NOT part of the schedule domain service: it holds no
 * business rows, bumps no revision, emits no change event and is wiped on
 * restart. It only bridges two halves of the schedule plugin that cannot
 * talk directly:
 *
 *   bridge (host, vivarium drops.onDrop) → this inbox → schedule client
 *   (polls the schedule API; a confirmed drop opens a new Agent session)
 *
 * A drop starts `pending` while the pet notice asks the user to confirm.
 * The bridge marks it `confirmed` on 「确认」 and discards it on 「取消」,
 * expiry or dismissal. The client only ever sees confirmed rows and acks
 * them after the session prompt is accepted, so a transient client failure
 * can retry without silently losing the material. The ack may carry the
 * sessionId the row was delivered to; `onDelivered` listeners (the pet
 * bridge uses this to follow the session's questions) hear it once per
 * hand-off.
 *
 * Keeping it in its own module makes the ownership explicit: the bridge does
 * not own UI state, the domain service does not own a transport queue, and
 * another plugin that wants the same handoff can model its own inbox without
 * growing `scheduleCore`.
 */
import { randomUUID } from 'node:crypto'

/** Oldest rows fall off first; confirmed rows are delivered quickly. */
const DROPBOX_CAP = 10
/** UTF-16 code units; the base enforces the same cap before calling us. */
const DROP_TEXT_CAP = 8_000
/** Match the base's image attachment budget. */
const DROP_IMAGES_CAP = 4
const DROP_IMAGE_BYTES_CAP = 20 * 1024 * 1024
const DROP_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
/** A notice that was never answered must not leave a forever-pending row. */
const DROP_PENDING_TTL_MS = 10 * 60_000

const normalizeImage = (raw) => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const mediaType = typeof raw.mediaType === 'string'
    ? raw.mediaType.trim().toLowerCase().replace(/^image\/jpg$/, 'image/jpeg')
    : ''
  if (!DROP_IMAGE_TYPES.has(mediaType)) return null
  if (typeof raw.data !== 'string' || raw.data === '') return null
  if (Math.floor(raw.data.length * 3 / 4) > DROP_IMAGE_BYTES_CAP) return null
  const name = typeof raw.name === 'string'
    ? raw.name.replace(/[\\/]+/g, '/').split('/').pop()?.trim().slice(0, 120) ?? ''
    : ''
  return { mediaType, data: raw.data, ...(name === '' ? {} : { name }) }
}

const normalizeDrop = (raw) => {
  if (typeof raw === 'string') raw = { text: raw }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (raw.text !== undefined && typeof raw.text !== 'string') return null
  const text = typeof raw.text === 'string' ? raw.text.trim() : ''
  if (text.length > DROP_TEXT_CAP) return null

  let images = []
  if (raw.images !== undefined) {
    if (!Array.isArray(raw.images) || raw.images.length > DROP_IMAGES_CAP) return null
    images = []
    for (const image of raw.images) {
      const normalized = normalizeImage(image)
      if (normalized === null) return null
      images.push(normalized)
    }
  }
  if (text === '' && images.length === 0) return null
  return {
    ...(text === '' ? {} : { text }),
    ...(images.length === 0 ? {} : { images }),
  }
}

const cloneRow = (row) => ({
  ...row,
  ...(row.images === undefined ? {} : { images: row.images.map(image => ({ ...image })) }),
})

/**
 * @param {object} [options]
 * @param {() => string} [options.now] - ISO timestamp seam (tests).
 * @param {() => string} [options.uuid] - id seam (tests).
 */
export function createDropbox({ now = () => new Date().toISOString(), uuid = randomUUID } = {}) {
  let rows = []
  const deliveredListeners = new Set()

  const notifyDelivered = (sessionId) => {
    for (const listener of [...deliveredListeners]) {
      try {
        listener(sessionId)
      } catch {
        // A listener's crash must not break the ack that triggered it.
      }
    }
  }

  const prune = () => {
    const cutoff = Date.parse(now()) - DROP_PENDING_TTL_MS
    rows = rows.filter(row => row.confirmedAt !== undefined || Date.parse(row.at) >= cutoff)
  }

  const find = (id) => rows.findIndex(row => row.id === id)

  return {
    /**
     * Stage one dropped payload. Invalid/blank input is ignored (returns
     * null) rather than thrown: the bridge is a best-effort surface, not a
     * CLI. A string is accepted as the legacy text-only shorthand.
     * @returns {{id: string, text?: string, images?: object[], at: string} | null}
     */
    stage(raw) {
      prune()
      const drop = normalizeDrop(raw)
      if (drop === null) return null
      const row = { id: uuid(), ...drop, at: now() }
      rows = [...rows, row].slice(-DROPBOX_CAP)
      return cloneRow(row)
    },

    /** Ask the user — mark a pending row deliverable. */
    confirm(id) {
      prune()
      const index = find(id)
      if (index < 0 || rows[index].confirmedAt !== undefined) return false
      rows[index] = { ...rows[index], confirmedAt: now() }
      return true
    },

    /** Drop a pending/confirmed row the user declined or that expired. */
    discard(id) {
      const before = rows.length
      rows = rows.filter(row => row.id !== id)
      return rows.length !== before
    },

    /** Peek without consuming (diagnostics/tests). */
    list() {
      prune()
      return rows.map(cloneRow)
    },

    /** Rows the user confirmed and the client has not acknowledged yet. */
    listConfirmed() {
      prune()
      return rows.filter(row => row.confirmedAt !== undefined).map(cloneRow)
    },

    /**
     * Hear which Agent session a row was delivered to. Fired from `ack`
     * calls that carry a sessionId — the transport's fact, not a promise
     * that the session is still alive.
     */
    onDelivered(listener) {
      deliveredListeners.add(listener)
      return () => {
        deliveredListeners.delete(listener)
      }
    },

    /** Remove delivered rows after the client accepted the prompt. */
    ack(ids, sessionId) {
      if (!Array.isArray(ids)) return 0
      const remove = new Set(ids.filter(id => typeof id === 'string' && id !== ''))
      const before = rows.length
      rows = rows.filter(row => !remove.has(row.id))
      if (typeof sessionId === 'string' && sessionId !== '' && rows.length !== before) {
        notifyDelivered(sessionId)
      }
      return before - rows.length
    },

    /** Current depth (diagnostics/tests). */
    get size() {
      prune()
      return rows.length
    },
  }
}

export const DROPBOX_LIMITS = Object.freeze({
  entries: DROPBOX_CAP,
  text: DROP_TEXT_CAP,
  images: DROP_IMAGES_CAP,
  imageBytes: DROP_IMAGE_BYTES_CAP,
  pendingMs: DROP_PENDING_TTL_MS,
})
