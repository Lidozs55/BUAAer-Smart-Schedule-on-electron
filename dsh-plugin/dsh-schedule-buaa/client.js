/**
 * Client half of @buaaer/dsh-schedule-buaa. Contributes the BUAA cards into
 * the core's 日程设置 page (`schedule.settings.blocks`) and a remote check-in
 * action into the core's entry editor (`schedule.entry.actions`), so the user
 * sees one settings section and one entry dialog no matter how many sources
 * are installed. The calendar panel itself belongs to the core plugin, which
 * this bundle depends on.
 */
window.__ModuleLoader__.load({
  id: '@buaaer/dsh-schedule-buaa',
  factory: (require) => {
    const NS = 'buaaScheduleImport'

    return {
      inject: ['slots', 'locale'],

      async apply(ctx) {
        // The API chunk must materialize before the UI chunks that sync-require it.
        await require.async('./client.api.js')
        const settings = await require.async('./client.settings.js')
        const signin = await require.async('./client.signin.js')

        ctx.effect(() => ctx.locale.register(NS, {
          zh: { ...settings.zh, ...signin.zh },
          en: { ...settings.en, ...signin.en },
        }), 'buaa-schedule: dictionaries')

        // Declared by the core's `settings.section` entry; `inject` waits
        // until that entry mounts. Styling comes from the core's stylesheet.
        ctx.slots.inject('schedule.settings.blocks', () => ctx.slots.register(
          { name: 'schedule.settings.blocks', id: 'buaa-settings', order: 10, locale: NS },
          settings.SettingsSection))

        // Declared by the core's `main` calendar entry and rendered from its
        // entry editor. The action is a no-op for non-BUAA / non-today rows.
        ctx.slots.inject('schedule.entry.actions', () => ctx.slots.register(
          { name: 'schedule.entry.actions', id: 'buaa-signin', order: 10, locale: NS },
          signin.SigninAction))
      },
    }
  },
})
