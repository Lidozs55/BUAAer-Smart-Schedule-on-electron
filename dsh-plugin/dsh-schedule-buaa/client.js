/**
 * Client half of @buaaer/dsh-schedule-buaa. Contributes the BUAA cards into
 * the core's 日程设置 page (`schedule.settings.blocks`), so the user sees one
 * settings section no matter how many sources are installed. The calendar
 * panel itself belongs to the core plugin, which this bundle depends on.
 */
window.__ModuleLoader__.load({
  id: '@buaaer/dsh-schedule-buaa',
  factory: (require) => {
    const NS = 'buaaScheduleImport'

    return {
      inject: ['slots', 'locale'],

      async apply(ctx) {
        const settings = await require.async('./client.settings.js')

        ctx.effect(() => ctx.locale.register(NS, { zh: settings.zh, en: settings.en }), 'buaa-schedule: dictionaries')

        // Declared by the core's `settings.section` entry; `inject` waits
        // until that entry mounts. Styling comes from the core's stylesheet.
        ctx.slots.inject('schedule.settings.blocks', () => ctx.slots.register(
          { name: 'schedule.settings.blocks', id: 'buaa-import', order: 10, locale: NS },
          settings.SettingsSection))
      },
    }
  },
})
