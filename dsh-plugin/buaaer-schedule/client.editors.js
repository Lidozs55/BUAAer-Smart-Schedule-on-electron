/**
 * Entry editor dialog: the manual (no-LLM) creation path. Conflict
 * rejections come back with reasons; the user can retry allowing overlap.
 */
window.__ModuleLoader__.load({
  id: '@buaaer/dsh-schedule/client.editors.js',
  factory: (require) => {
    const core = require('@buaaer/dsh-schedule/client.core.js')
    const { React, h, field } = core
    const { useState, useEffect } = React
    const { Modal } = core

    const CATEGORIES = ['course', 'homework', 'exam', 'meeting', 'study', 'sports', 'other']

    const toLocalInput = iso => {
      const date = new Date(iso)
      const p = n => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}:${p(date.getMinutes())}`
    }

    /**
     * @param {object} props - `{ t, initial, api, onClose, onSaved }`;
     * `initial` null means create (with `draft` start/end), else edit.
     */
    function EventEditor(props) {
      const { t, initial, api, onClose, onSaved } = props
      const draft = props.draft ?? {}
      const [title, setTitle] = useState(initial?.title ?? '')
      const [category, setCategory] = useState(initial?.category ?? 'other')
      const [start, setStart] = useState(toLocalInput(initial?.start ?? draft.start ?? new Date()))
      const [end, setEnd] = useState(toLocalInput(initial?.end ?? draft.end ?? new Date(Date.now() + 3_600_000)))
      const [description, setDescription] = useState(initial?.description ?? '')
      const [error, setError] = useState(null)
      const [conflicts, setConflicts] = useState(null)
      const [busy, setBusy] = useState(false)

      const save = async allowConflicts => {
        setBusy(true)
        setError(null)
        try {
          const input = {
            title,
            category,
            description,
            start: zoneLocal(start),
            end: zoneLocal(end),
          }
          const saved = initial === null
            ? await api.createEntry(input, { allowConflicts })
            : await api.updateEntry(initial.id, input, { allowConflicts })
          onSaved(saved)
          onClose()
        } catch (cause) {
          if (cause.code === 'conflict') setConflicts(cause.details?.conflicts ?? [])
          else setError(cause.message ?? String(cause))
        } finally {
          setBusy(false)
        }
      }

      return h(Modal, { title: t(initial === null ? 'entry.create' : 'entry.edit'), onClose },
        conflicts !== null
          ? h('div', { className: 'bsch-error' },
              h('div', null, t('conflict.title')),
              conflicts.map((conflict, i) => h('div', { key: i }, conflict.reason)),
              h('div', { className: 'bsch-modal-actions' },
                h('button', { className: 'bsch-btn', onClick: () => setConflicts(null) }, t('entry.cancel')),
                h('button', { className: 'bsch-btn', onClick: () => { setConflicts(null); void save(true) } }, t('conflict.proceed'))))
          : h('div', null,
              field(t('entry.title'), h('input', {
                className: 'bsch-input', value: title, autoFocus: true,
                onChange: e => setTitle(e.target.value),
              })),
              field(t('entry.category'), h('select', {
                className: 'bsch-select', value: category,
                onChange: e => setCategory(e.target.value),
              }, CATEGORIES.map(cat => h('option', { key: cat, value: cat }, t('cat.' + cat))))),
              field(t('entry.start'), h('input', {
                className: 'bsch-input', type: 'datetime-local', value: start,
                onChange: e => setStart(e.target.value),
              })),
              field(t('entry.end'), h('input', {
                className: 'bsch-input', type: 'datetime-local', value: end,
                onChange: e => setEnd(e.target.value),
              })),
              field(t('entry.description'), h('textarea', {
                className: 'bsch-textarea', value: description, rows: 2,
                onChange: e => setDescription(e.target.value),
              })),
              error !== null ? h('div', { className: 'bsch-error' }, error) : null,
              h('div', { className: 'bsch-modal-actions' },
                initial !== null ? h('button', {
                  className: 'bsch-btn is-danger',
                  onClick: async () => {
                    await api.deleteEntry(initial.id)
                    onSaved({ deleted: initial.id })
                    onClose()
                  },
                }, t('entry.delete')) : null,
                h('button', { className: 'bsch-btn', onClick: onClose }, t('entry.cancel')),
                h('button', {
                  className: 'bsch-btn is-primary', disabled: busy || title.trim() === '',
                  onClick: () => void save(false),
                }, t('entry.save')))))
    }

    /** `datetime-local` values are browser-local wall times; emit them
     *  with the browser's explicit offset so the wire format is honest. */
    const zoneLocal = value => core.dateToZonedIso(new Date(value))

    return { EventEditor, zoneLocal, toLocalInput }
  },
})
