/**
 * Client half of @lidozs55/dsh-schedule-gacha.
 *
 * Contributes one settings card into the core's 日程设置 page
 * (`schedule.settings.blocks`). The card owns only the six per-game switches,
 * the refresh trigger and the “let an Agent verify” hand-off; the calendar
 * itself remains the core plugin's panel.
 */
window.__ModuleLoader__.load({
  id: '@lidozs55/dsh-schedule-gacha',
  factory: require => {
    const NS = 'gachaSchedule'

    return {
      // `remote.session` + `uiWorkspace` back the hand-off into a normal
      // Agent session; `timer` polls while a background refresh is running.
      inject: ['slots', 'locale', 'remote', 'remote.session', 'uiWorkspace', 'timer'],

      async apply(ctx) {
        const settings = await require.async('./client.settings.js')

        ctx.effect(() => ctx.locale.register(NS, { zh: settings.zh, en: settings.en }),
          'gacha-schedule: dictionaries')

        const env = {
          timer: ctx.timer,
          session: {
            create: request => ctx.remote.session.create(request),
            prompt: request => ctx.remote.session.prompt(request),
          },
          openSession: id => {
            try {
              ctx.uiWorkspace.openSession(id)
            } catch {
              // The workspace panel may be gone; the session still exists.
            }
          },
        }

        // The core's `settings.section` entry declares this child slot, so
        // `inject` parks this registration until that page is mounted.
        ctx.slots.inject('schedule.settings.blocks', () => ctx.slots.register(
          {
            name: 'schedule.settings.blocks',
            id: 'gacha-settings',
            order: 20,
            locale: NS,
            inject: () => ({ env }),
          },
          settings.SettingsSection))
      },
    }
  },
})
