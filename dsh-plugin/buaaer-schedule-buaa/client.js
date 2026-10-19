/**
 * Client half of @buaaer/dsh-schedule-buaa. Registers one settings section;
 * the calendar panel itself belongs to the core plugin, which this bundle
 * depends on.
 */
window.__ModuleLoader__.load({
  id: '@buaaer/dsh-schedule-buaa',
  factory: (require) => {
    const NS = 'buaaScheduleImport'

    return {
      inject: ['slots', 'locale'],

      async apply(ctx) {
        const settings = await require.async('./client.settings.js')
        const style = await require.async('./client.style.js')

        ctx.effect(() => ctx.locale.register(NS, { zh: settings.zh, en: settings.en }), 'buaaer-buaa: dictionaries')
        const t = ctx.locale.bind(NS)

        ctx.effect(() => {
          const el = document.createElement('style')
          el.dataset.plugin = '@buaaer/dsh-schedule-buaa'
          el.textContent = style
          document.head.append(el)
          return () => el.remove()
        }, 'buaaer-buaa: styles')

        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'buaaer-schedule-buaa', order: 101, locale: NS, label: () => t('panel.settings') },
          settings.SettingsSection))
      },
    }
  },
})
