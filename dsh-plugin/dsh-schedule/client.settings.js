/**
 * SettingsSection: the generic `settings.section` entry — teaching-week
 * anchor, full-domain JSON export/import, and the `schedule.settings.blocks`
 * child slot that calendar sources append their own cards into (so every
 * school source shows up inside this one page, not as its own section).
 */
window.__ModuleLoader__.load({
  id: '@lidozs55/dsh-schedule/client.settings.js',
  factory: (require) => {
    const core = require('@lidozs55/dsh-schedule/client.core.js')
    const { React, h, field } = core
    const { useState, useEffect } = React

    /**
     * @param {object} props - slot props (owner share: `{ close }`) plus
     *   `env` = `{ api }` from the registration's inject share.
     */
    function SettingsSection(props) {
      const { t, env } = props
      const api = env.api
      const [meta, setMeta] = useState(null)
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState(false)

      useEffect(() => { void load() }, [])
      async function load() {
        try {
          // Any snapshot carries the global meta; this week's is as good as any.
          setMeta((await api.snapshot()).global)
        } catch (cause) {
          setStatus({ ok: false, text: cause.message })
        }
      }

      const saveMeta = async patch => {
        setBusy(true)
        try {
          setMeta(await api.setMeta(patch))
          setStatus({ ok: true, text: t('settings.saved') })
        } catch (cause) {
          setStatus({ ok: false, text: cause.message })
        } finally {
          setBusy(false)
        }
      }

      const exportJson = async () => {
        const data = await api.exportData()
        const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), ...data }, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `schedule-core-${new Date().toISOString().slice(0, 10)}.json`
        anchor.click()
        URL.revokeObjectURL(url)
      }

      const importJson = async event => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file === undefined) return
        setBusy(true)
        try {
          const counts = await api.importData(JSON.parse(await file.text()))
          setStatus({
            ok: true,
            text: t('settings.imported').replace('{summary}',
              `课程 ${counts.courses.created + counts.courses.updated}，条目 ${counts.entries.created}（跳过 ${counts.entries.skipped}），任务 ${counts.tasks.created}（跳过 ${counts.tasks.skipped}）`),
          })
        } catch (cause) {
          setStatus({ ok: false, text: t('settings.importFail').replace('{message}', cause.message) })
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: 'bsch-settings' },
        h('div', { className: 'bsch-card' },
          h('h3', null, t('panel.settings')),
          field(t('settings.termStart'), h('input', {
            className: 'bsch-input', type: 'date', value: meta?.termStart ?? '',
            onChange: e => setMeta({ ...meta, termStart: e.target.value }),
          })),
          h('div', { className: 'bsch-hint' }, t('settings.termHint')),
          h('div', { className: 'bsch-rowline' },
            h('span', { className: 'bsch-spacer' }),
            h('button', {
              className: 'bsch-btn is-primary', disabled: busy,
              onClick: () => void saveMeta({ termStart: meta?.termStart ?? '' }),
            }, t('entry.save')))),
        h('div', { className: 'bsch-card' },
          h('h3', null, t('settings.dataTitle')),
          h('div', { className: 'bsch-rowline' },
            h('button', { className: 'bsch-btn', onClick: () => void exportJson() }, t('settings.export')),
            h('span', { className: 'bsch-spacer' }),
            h('label', { className: 'bsch-btn' },
              t('settings.import'),
              h('input', {
                type: 'file', accept: 'application/json', style: { display: 'none' },
                onChange: e => void importJson(e),
              })))),
        // Source adapters contribute their own cards underneath the generic
        // ones.
        props.renderSlot('schedule.settings.blocks', {}),
        status !== null ? h('div', {
          className: `bsch-hint${status.ok ? '' : ' bsch-error'}`,
        }, status.text) : null)
    }

    return { SettingsSection }
  },
})
