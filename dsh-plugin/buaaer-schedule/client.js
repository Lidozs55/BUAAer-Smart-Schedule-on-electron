/**
 * Client half of @buaaer/dsh-schedule. Loads the package-local chunks
 * (`require.async('./client.*.js')` — the module system's chunk protocol;
 * core must materialize before the chunks that require it), then
 * registers the two `main` panels, their `sidebar.panellist` entries, and
 * the settings section. All registrations ride `ctx.slots.inject` so
 * declarations own their lifecycles; styles inject through `ctx.effect`.
 */
window.__ModuleLoader__.load({
  id: '@buaaer/dsh-schedule',
  factory: (require) => {
    const NS = 'buaaerSchedule'

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
    const clipboardIcon = icon('M5.5 2.5h5v2h-5zM3.5 4.5h9v9h-9zM5.5 8h5M5.5 10.5h3')

    return {
      inject: ['slots', 'locale', 'remote', 'remote.session', 'uiWorkspace'],

      async apply(ctx) {
        const core = await require.async('./client.core.js')
        const { CalendarPanel } = await require.async('./client.calendar.js')
        const { ClipboardPanel } = await require.async('./client.clipboard.js')
        const { SettingsSection } = await require.async('./client.settings.js')
        const style = await require.async('./client.style.js')

        ctx.effect(() => ctx.locale.register(NS, { zh: core.zh, en: core.en }), 'buaaer: dictionaries')
        const t = ctx.locale.bind(NS)

        ctx.effect(() => {
          const el = document.createElement('style')
          el.dataset.plugin = '@buaaer/dsh-schedule'
          el.textContent = style
          document.head.append(el)
          return () => el.remove()
        }, 'buaaer: styles')

        // Shared inject shares: the /api client, a releasable timer, and
        // the session helpers the clipboard panel needs (D-2).
        const env = {
          api: core.createApi(),
          timer: ctx.timer,
          openSession: id => { try { ctx.uiWorkspace.openSession(id) } catch { /* panel gone */ } },
          session: {
            create: request => ctx.remote.session.create(request),
            prompt: request => ctx.remote.session.prompt(request),
          },
        }
        const share = () => ({ env })

        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: 'buaaer-calendar', locale: NS, inject: share }, CalendarPanel))
        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: 'buaaer-clipboard', locale: NS, inject: share }, ClipboardPanel))
        // The list id must equal the main key it selects.
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: 'buaaer-calendar', order: 40, locale: NS, label: () => t('panel.calendar') },
          calendarIcon))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: 'buaaer-clipboard', order: 41, locale: NS, label: () => t('panel.clipboard') },
          clipboardIcon))
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'buaaer-schedule', order: 100, locale: NS, label: () => t('panel.settings') },
          SettingsSection))
      },
    }
  },
})
