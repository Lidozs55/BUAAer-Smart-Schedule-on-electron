/**
 * Client half of @lidozs55/dsh-schedule. Loads the package-local chunks
 * (`require.async('./client.*.js')` — the module system's chunk protocol;
 * core must materialize before the chunks that require it), then starts the
 * reminder notification poller and registers the `main` panel
 * (日程/任务/剪贴板 tabs inside), its `sidebar.panellist` entry, and the
 * settings section. All registrations ride `ctx.slots.inject` so
 * declarations own their lifecycles; styles inject through `ctx.effect`.
 */
window.__ModuleLoader__.load({
  id: '@lidozs55/dsh-schedule',
  factory: (require) => {
    const NS = 'scheduleCore'

    const icon = path => (props) => {
      const size = props.size ?? 16
      const React = require('react')
      return React.createElement('svg', {
        width: size, height: size, viewBox: '0 0 16 16',
        fill: 'none', 'aria-hidden': 'true', className: 'bsch-icon',
      }, React.createElement('path', {
        d: path,
        stroke: 'currentColor', 'stroke-width': 1.2, 'stroke-linejoin': 'round',
      }))
    }
    const calendarIcon = icon('M2.5 4.5h11v9h-11zM2.5 7.5h11M5 2.5v2.5M11 2.5v2.5')

    return {
      // Every ctx.* service read in apply must be declared here — the
      // runner guards the dynamic-plugin context and refuses undeclared
      // property access ("cannot get property ... without inject").
      // `timer` backs the calendar/clipboard refresh scheduling.
      inject: ['slots', 'locale', 'remote', 'remote.session', 'uiWorkspace', 'timer'],

      async apply(ctx) {
        // Every chunk must be materialized here before any chunk that
        // synchronously requires it: the sync `require` of a package-local
        // chunk only sees already-materialized modules (loadCache), so the
        // load order below is a dependency order — core first, then the
        // leaf chunks, then calendar which sync-requires them.
        const core = await require.async('./client.core.js')
        const notify = await require.async('./client.notify.js')
        await require.async('./client.gridmath.js')
        await require.async('./client.weekgrid.js')
        await require.async('./client.editors.js')
        await require.async('./client.tasks.js')
        const clipboard = await require.async('./client.clipboard.js')
        const { CalendarPanel } = await require.async('./client.calendar.js')
        const { SettingsSection } = await require.async('./client.settings.js')
        const style = await require.async('./client.style.js')

        ctx.effect(() => ctx.locale.register(NS, { zh: core.zh, en: core.en }), 'schedule: dictionaries')
        const t = ctx.locale.bind(NS)
        const api = core.createApi()

        // Shared inject shares: the /api client, a releasable timer, and
        // the session helpers the clipboard panel and pet-drop hand-off need
        // (D-2).
        const env = {
          api,
          timer: ctx.timer,
          openSession: id => { try { ctx.uiWorkspace.openSession(id) } catch { /* panel gone */ } },
          session: {
            create: request => ctx.remote.session.create(request),
            prompt: request => ctx.remote.session.prompt(request),
          },
        }

        // Clipboard capture is global, like the original app: copying text
        // while any other panel/session is open still fills the queue. The
        // same monitor polls confirmed pet drops and opens a fresh Agent
        // session for them — pet drops never enter the clipboard queue.
        ctx.effect(() => clipboard.startClipboardMonitor({ api, env }), 'schedule: clipboard monitor')

        ctx.effect(() => {
          const el = document.createElement('style')
          el.dataset.plugin = '@lidozs55/dsh-schedule'
          el.textContent = style
          document.head.append(el)
          return () => el.remove()
        }, 'schedule: styles')

        const share = () => ({ env })

        // Core-owned reminder surface: poll the host-derived set and raise a
        // Web Notification (or an in-page toast) while the app is open. The
        // pet bridge, when installed, is an additional surface over the same
        // set — never a dependency.
        ctx.effect(() => notify.startReminderNotifications({
          api: env.api, timer: ctx.timer, t,
        }), 'schedule: reminder notifications')

        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: 'schedule-calendar', locale: NS, inject: share,
            // Source adapters can attach actions to an opened entry (e.g. BUAA's
            // remote check-in). The editor renders this list with the entry as
            // owner props; the core itself never names a source.
            children: { 'schedule.entry.actions': { kind: 'list', scope: 'root' } } },
          CalendarPanel))
        // The list id must equal the main key it selects.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: 'schedule-calendar', order: 40, locale: NS, label: () => t('panel.calendar') },
          calendarIcon))
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'schedule-core', order: 100, locale: NS, label: () => t('panel.settings'), inject: share,
            // Source adapters append their settings cards here instead of
            // registering a section of their own (one 日程设置 page).
            children: { 'schedule.settings.blocks': { kind: 'list', scope: 'root' } } },
          SettingsSection))
      },
    }
  },
})
