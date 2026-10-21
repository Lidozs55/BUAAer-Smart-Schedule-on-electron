/**
 * Client reminder notifier: the core-owned notification surface.
 *
 * There is no push channel for plugin data, so this polls the host-derived
 * reminder set (`GET /api/schedule-core?view=reminders`) every 30 seconds.
 * A reminder fires inside the 60-second window before its `at` moment — the
 * same "at most one minute early, never late" rule the pet bridge uses.
 *
 * Surfaces:
 *   - foreground: an in-page toast (always available);
 *   - background: a Web Notification when the user has granted permission.
 *
 * Dedup lives here: `key@at` is the deterministic id, and a small
 * localStorage map keeps a reload from re-firing the same moment.
 */
window.__ModuleLoader__.load({
  id: '@lidozs55/dsh-schedule/client.notify.js',
  factory: () => {
    const POLL_MS = 30_000
    const LEAD_MS = 60_000
    const TOAST_MS = 20_000
    const STORAGE_KEY = 'dsh-schedule:notified'
    const fired = new Map()

    const supported = () =>
      typeof window !== 'undefined' && typeof window.Notification === 'function'

    const notificationStatus = () => {
      if (!supported()) return 'unsupported'
      return window.Notification.permission
    }

    const loadFired = () => {
      try {
        const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}')
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
        for (const [key, at] of Object.entries(raw)) {
          if (Number(at) >= cutoff) fired.set(key, Number(at))
        }
      } catch { /* storage unavailable: in-memory dedup still works */ }
    }

    const saveFired = () => {
      try {
        const raw = {}
        for (const [key, at] of fired) raw[key] = at
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(raw))
      } catch { /* quota/privacy mode: ignore */ }
    }

    const shortTime = iso => String(iso).replace('T', ' ').slice(0, 16)

    // Function replacement avoids `$&`-style expansion if a title contains
    // dollar signs.
    const fill = (template, values) =>
      template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '')

    const format = (reminder, t) => {
      if (reminder.kind === 'class') {
        return {
          title: t('notify.classTitle'),
          body: fill(t('notify.classBody'), {
            title: reminder.title,
            time: shortTime(reminder.start),
            room: reminder.classroom ? `（${reminder.classroom}）` : '',
          }),
        }
      }
      if (reminder.kind === 'entry') {
        if (reminder.allDay === true) {
          return {
            title: t('notify.entryTitle'),
            body: fill(t('notify.entryAllDay'), {
              title: reminder.title,
              date: String(reminder.start).slice(0, 10),
            }),
          }
        }
        return {
          title: t('notify.entryTitle'),
          body: fill(t('notify.entryBody'), {
            title: reminder.title,
            time: shortTime(reminder.start),
          }),
        }
      }
      return {
        title: t('notify.taskTitle'),
        body: fill(t('notify.taskBody'), {
          title: reminder.title,
          time: shortTime(reminder.due),
        }),
      }
    }

    let toastHost = null
    const ensureToastHost = () => {
      if (toastHost !== null && toastHost.isConnected) return toastHost
      toastHost = document.createElement('div')
      toastHost.className = 'bsch-toast-host'
      toastHost.setAttribute('aria-live', 'polite')
      document.body.append(toastHost)
      return toastHost
    }

    const showToast = (title, body) => {
      try {
        const host = ensureToastHost()
        const toast = document.createElement('div')
        toast.className = 'bsch-toast'
        toast.setAttribute('role', 'status')
        const heading = document.createElement('div')
        heading.className = 'bsch-toast-title'
        heading.textContent = title
        const text = document.createElement('div')
        text.className = 'bsch-toast-body'
        text.textContent = body
        toast.append(heading, text)
        host.append(toast)
        window.setTimeout(() => toast.remove(), TOAST_MS)
      } catch { /* DOM gone: nothing to show */ }
    }

    const showSystem = (title, body, tag) => {
      if (notificationStatus() !== 'granted') return false
      try {
        const notification = new window.Notification(title, { body, tag })
        notification.onclick = () => {
          try { window.focus() } catch { /* ignore */ }
          notification.close()
        }
        return true
      } catch {
        return false
      }
    }

    const isDue = (atIso, now) => {
      const at = Date.parse(atIso)
      if (!Number.isFinite(at)) return false
      const delta = at - now
      return delta <= LEAD_MS && delta >= -30_000
    }

    const requestBrowserNotifications = async () => {
      if (!supported()) return 'unsupported'
      if (window.Notification.permission === 'granted') return 'granted'
      try {
        return await window.Notification.requestPermission()
      } catch {
        return window.Notification.permission
      }
    }

    const startReminderNotifications = ({ api, timer, t }) => {
      if (api === undefined || typeof api.reminders !== 'function') return () => {}
      loadFired()
      let stopped = false

      const tick = async () => {
        try {
          const reminders = await api.reminders()
          if (stopped || !Array.isArray(reminders)) return
          const now = Date.now()
          for (const reminder of reminders) {
            if (!isDue(reminder.at, now)) continue
            const id = `${reminder.kind}:${reminder.key ?? reminder.taskId ?? reminder.title}@${reminder.at}`
            if (fired.has(id)) continue
            fired.set(id, now)
            saveFired()
            const { title, body } = format(reminder, t)
            const background = document.visibilityState === 'hidden'
            if (!(background && showSystem(title, body, id))) showToast(title, body)
          }
        } catch { /* transient API failure: next poll retries */ }
      }

      void tick()
      const dispose = timer !== undefined && timer !== null && typeof timer.interval === 'function'
        ? timer.interval(() => { void tick() }, POLL_MS)
        : (() => {
            const interval = window.setInterval(() => { void tick() }, POLL_MS)
            return () => window.clearInterval(interval)
          })()
      return () => {
        stopped = true
        dispose()
      }
    }

    return {
      startReminderNotifications,
      notificationStatus,
      requestBrowserNotifications,
      formatReminder: format,
      isDue,
    }
  },
})
