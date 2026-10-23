/**
 * Browser-side data channel shared by the BUAA settings card and the entry
 * check-in action. Kept in its own chunk so neither UI file has to import the
 * other: both receive the same `/api/buaa-schedule` client and the same error
 * decoding.
 */
window.__ModuleLoader__.load({
  id: '@buaaer/dsh-schedule-buaa/client.api.js',
  factory: () => {
    const API_PATH = '/api/buaa-schedule'

    class ApiError extends Error {
      constructor(payload) {
        super(payload.message)
        this.code = payload.code
        this.details = payload.details
      }
    }

    async function parseResult(response) {
      let body
      try {
        body = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (body && body.ok) return body.value
      throw new ApiError(body?.error ?? { code: 'http_' + response.status, message: `HTTP ${response.status}` })
    }

    const post = (op, payload) => globalThis.fetch(API_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op, ...payload }),
    }).then(parseResult)

    return {
      state: () => globalThis.fetch(API_PATH).then(parseResult),
      setStudentId: buaaId => post('setStudentId', { buaaId }),
      setSpocEnabled: enabled => post('setSpocEnabled', { enabled }),
      sync: creds => post('sync', creds),
      signin: entryId => post('signin', { entryId }),
    }
  },
})
