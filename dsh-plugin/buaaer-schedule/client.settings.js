/**
 * SettingsSection: the `settings.section` entry — student id, term
 * anchor, one-shot JW sync (password never leaves this form call), and
 * data import/export.
 */
window.__ModuleLoader__.load({
  id: '@buaaer/dsh-schedule/client.settings.js',
  factory: (require) => {
    const core = require('@buaaer/dsh-schedule/client.core.js')
    const { React, h, field, mondayOf } = core
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
      const [password, setPassword] = useState('')
      const [busy, setBusy] = useState(false)

      useEffect(() => { void load() }, [])
      async function load() {
        try {
          // Any snapshot carries the global meta; this week's is as good as any.
          setMeta((await api.snapshot(mondayOf(new Date().toISOString()))).global)
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

      const sync = async () => {
        setBusy(true)
        setStatus(null)
        try {
          const result = await api.startSync(meta?.buaaId ? { password } : { buaaId: null, password })
          setStatus({
            ok: true,
            text: result.jobId !== undefined
              ? t('settings.syncStarted')
              : t('settings.syncDone').replace('{summary}', summarize(result.summary)),
          })
          setPassword('')
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
        anchor.download = `buaaer-schedule-${new Date().toISOString().slice(0, 10)}.json`
        anchor.click()
        URL.revokeObjectURL(url)
      }

      const importJson = async event => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file === undefined) return
        setBusy(true)
        try {
          const counts = await api.importPayload(JSON.parse(await file.text()))
          setStatus({
            ok: true,
            text: t('settings.imported').replace('{summary}',
              `课程 ${counts.courses.created}，条目 ${counts.entries.created}（跳过 ${counts.entries.skipped}），任务 ${counts.tasks.created}（跳过 ${counts.tasks.skipped}）`),
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
          field(t('settings.buaaId'), h('input', {
            className: 'bsch-input', value: meta?.buaaId ?? '', placeholder: '23xxxxxx',
            onChange: e => setMeta({ ...meta, buaaId: e.target.value }),
          })),
          field(t('settings.termStart'), h('input', {
            className: 'bsch-input', type: 'date', value: meta?.termStart ?? '',
            onChange: e => setMeta({ ...meta, termStart: e.target.value }),
          })),
          h('div', { className: 'bsch-rowline' },
            h('span', { className: 'bsch-hint' }, `${t('settings.termCode')}: ${meta?.termCode || '—'}`),
            h('span', { className: 'bsch-spacer' }),
            h('button', {
              className: 'bsch-btn is-primary', disabled: busy,
              onClick: () => void saveMeta({ buaaId: meta?.buaaId ?? '', termStart: meta?.termStart ?? '' }),
            }, t('entry.save')))),
        h('div', { className: 'bsch-card' },
          h('h3', null, t('settings.syncTitle')),
          field(t('settings.password'), h('input', {
            className: 'bsch-input', type: 'password', value: password, autoComplete: 'off',
            onChange: e => setPassword(e.target.value),
          })),
          h('div', { className: 'bsch-rowline' },
            h('span', { className: 'bsch-spacer' }),
            h('button', {
              className: 'bsch-btn is-primary', disabled: busy || password === '',
              onClick: () => void sync(),
            }, t('settings.sync')))),
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
        status !== null ? h('div', {
          className: `bsch-hint${status.ok ? '' : ' bsch-error'}`,
        }, status.text) : null)
    }

    const summarize = summary =>
      `${summary.daysFetched}/7 天，课程 ${summary.courses.total} 条，考试 ${summary.exams.total} 条`

    return { SettingsSection }
  },
})
