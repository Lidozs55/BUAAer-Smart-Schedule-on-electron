/** Generic settings, category palette, backups, and source settings slot. */
window.__ModuleLoader__.load({
  id: '@lidozs55/dsh-schedule/client.settings.js',
  factory: (require) => {
    const core = require('@lidozs55/dsh-schedule/client.core.js')
    const { React, h, notifyDataChanged, ConfirmDialog, categoriesOrDefault, CategoryPreview } = core
    const { useState, useEffect, useRef } = React

    function SettingsSection(props) {
      const { t, env } = props
      const api = env.api
      const [meta, setMeta] = useState(null)
      const [categories, setCategories] = useState(null)
      const categoryDirty = useRef(false)
      const termDirty = useRef(false)
      const loadSequence = useRef(0)
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState(false)
      const [confirmClear, setConfirmClear] = useState(false)
      const [deleteCategory, setDeleteCategory] = useState(null)
      const importInput = useRef(null)

      useEffect(() => {
        void load()
        const update = () => { void load() }
        window.addEventListener(core.DATA_CHANGED_EVENT, update)
        return () => { ++loadSequence.current; window.removeEventListener(core.DATA_CHANGED_EVENT, update) }
      }, [api])
      async function load() {
        const sequence = ++loadSequence.current
        try {
          const next = (await api.snapshot()).global
          if (sequence !== loadSequence.current) return
          setMeta(prev => ({ ...next, ...(termDirty.current ? { termStart: prev?.termStart ?? '' } : {}) }))
          // Unrelated source/term updates must never replace an unsaved palette.
          if (!categoryDirty.current) setCategories(categoriesOrDefault(next.categories).map(cat => ({ ...cat })))
        } catch (cause) {
          if (sequence === loadSequence.current) setStatus({ ok: false, text: cause.message })
        }
      }

      const saveMeta = async patch => {
        setBusy(true)
        try {
          const next = await api.setMeta(patch)
          // setMeta returns full metadata, but owns only the submitted fields.
          setMeta(prev => ({ ...prev, termStart: next.termStart }))
          termDirty.current = false
          notifyDataChanged()
          setStatus({ ok: true, text: t('settings.saved') })
        } catch (cause) {
          setStatus({ ok: false, text: cause.message })
        } finally { setBusy(false) }
      }
      const editCategories = next => {
        categoryDirty.current = true
        setCategories(next)
      }
      const changeCategory = (id, patch) => editCategories(categories.map(cat => cat.id === id ? { ...cat, ...patch } : cat))
      const saveCategories = async () => {
        if (categories.some(cat => !cat.name.trim())) {
          setStatus({ ok: false, text: t('settings.categoryNameRequired') })
          return
        }
        setBusy(true)
        try {
          const next = await api.setCategories(categories.map(cat => ({ ...cat, name: cat.name.trim() })))
          setMeta(prev => ({ ...prev, categories: next.categories }))
          setCategories(next.categories.map(cat => ({ ...cat })))
          categoryDirty.current = false
          notifyDataChanged()
          setStatus({ ok: true, text: t('settings.saved') })
        } catch (cause) {
          // Keep the entire draft (including removals and new stable ids).
          setStatus({ ok: false, text: cause.message })
        } finally { setBusy(false) }
      }
      const addCategory = () => {
        editCategories([...categories, { id: `custom-${globalThis.crypto.randomUUID()}`, name: t('settings.newCategory'), color: '#3B82F6' }])
      }

      const exportJson = async () => {
        try {
          const data = await api.exportData()
          const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), ...data }, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = `schedule-core-${new Date().toISOString().slice(0, 10)}.json`
          anchor.click()
          URL.revokeObjectURL(url)
        } catch (cause) { setStatus({ ok: false, text: cause.message }) }
      }
      const importJson = async event => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file === undefined) return
        setBusy(true)
        try {
          const counts = await api.importData(JSON.parse(await file.text()))
          await load()
          notifyDataChanged()
          setStatus({ ok: true, text: t('settings.imported').replace('{summary}',
            `条目 ${counts.entries.created}（跳过 ${counts.entries.skipped}），任务 ${counts.tasks.created}（跳过 ${counts.tasks.skipped}）`) })
        } catch (cause) {
          setStatus({ ok: false, text: t('settings.importFail').replace('{message}', cause.message) })
        } finally { setBusy(false) }
      }
      const clearAll = async () => {
        setBusy(true)
        try {
          const { deleted } = await api.clearAllData()
          notifyDataChanged()
          setStatus({ ok: true, text: t('settings.clearedAll').replace('{count}', String(deleted)) })
        } catch (cause) { setStatus({ ok: false, text: cause.message }) }
        finally { setBusy(false) }
      }
      return h('div', { className: 'bsch-settings' },
        h('section', { className: 'bsch-settings-section', 'aria-labelledby': 'bsch-general-heading' },
          h('h3', { className: 'bsch-settings-heading', id: 'bsch-general-heading' }, t('settings.general')),
          h('div', { className: 'bsch-setting-row' },
            h('label', { className: 'bsch-setting-label', htmlFor: 'bsch-term-start' }, t('settings.termStart')),
            h('div', { className: 'bsch-setting-control' },
              h('div', { className: 'bsch-settings-inline' },
                h('input', {
                  id: 'bsch-term-start', 'aria-describedby': 'bsch-term-hint',
                  className: 'bsch-input', type: 'date', value: meta?.termStart ?? '', disabled: busy || meta === null,
                  onChange: e => { termDirty.current = true; setMeta(prev => ({ ...prev, termStart: e.target.value })) },
                }),
                h('button', { className: 'bsch-btn is-primary', disabled: busy || meta === null,
                  onClick: () => void saveMeta({ termStart: meta?.termStart ?? '' }),
                }, t('entry.save'))),
              h('div', { className: 'bsch-hint', id: 'bsch-term-hint' }, t('settings.termHint'))))),
        h('section', { className: 'bsch-settings-section bsch-category-card', 'aria-labelledby': 'bsch-category-heading' },
          h('div', { className: 'bsch-settings-header' },
            h('h3', { className: 'bsch-settings-heading', id: 'bsch-category-heading' }, t('settings.categories')),
            h('button', { className: 'bsch-btn', disabled: busy || categories === null, onClick: addCategory }, t('settings.addCategory'))),
          h('div', { className: 'bsch-hint' }, t('settings.categoryHint')),
          categories === null ? h('div', { className: 'bsch-hint' }, t('state.loading'))
            : h('div', { className: 'bsch-category-list' }, categories.map(cat => h('div', {
                key: cat.id, className: 'bsch-category-row', 'data-category-id': cat.id,
              },
              h('input', { className: 'bsch-input bsch-category-name', value: cat.id === 'other' ? '其它' : cat.name,
                'aria-label': t('settings.categoryName'), readOnly: cat.id === 'other', disabled: busy,
                onChange: e => { if (cat.id !== 'other') changeCategory(cat.id, { name: e.target.value }) },
              }),
              h('label', { className: 'bsch-color-picker', title: t('settings.categoryColor') },
                h('input', { type: 'color', value: cat.color, disabled: busy,
                  'aria-label': `${cat.name} · ${t('settings.categoryColor')}`,
                  onChange: e => changeCategory(cat.id, { color: e.target.value.toUpperCase() }),
                }), h('span', null, cat.color)),
              h('button', { className: 'bsch-btn is-danger', disabled: busy || cat.id === 'other',
                'aria-label': `${t('entry.delete')} ${cat.name}`, title: cat.id === 'other' ? t('settings.otherProtected') : t('entry.delete'),
                onClick: () => { if (cat.id !== 'other') setDeleteCategory(cat) },
              }, '×'),
              h(CategoryPreview, { category: cat.id, categories })))),
          h('div', { className: 'bsch-settings-actions' },
            categoryDirty.current ? h('span', { className: 'bsch-hint' }, t('settings.unsaved')) : null,
            h('button', { className: 'bsch-btn', disabled: busy || !categoryDirty.current,
              onClick: () => { categoryDirty.current = false; setCategories(categoriesOrDefault(meta?.categories).map(cat => ({ ...cat }))) },
            }, t('entry.cancel')),
            h('button', { className: 'bsch-btn is-primary', disabled: busy || !categoryDirty.current,
              onClick: () => void saveCategories(),
            }, t('settings.saveCategories')))),
        h('section', { className: 'bsch-settings-section', 'aria-labelledby': 'bsch-data-heading' },
          h('h3', { className: 'bsch-settings-heading', id: 'bsch-data-heading' }, t('settings.dataTitle')),
          h('div', { className: 'bsch-setting-row' },
            h('span', { className: 'bsch-setting-label' }, t('settings.backup')),
            h('div', { className: 'bsch-settings-actions' },
              h('button', { className: 'bsch-btn', disabled: busy, onClick: () => void exportJson() }, t('settings.export')),
              h('button', { className: 'bsch-btn', disabled: busy, onClick: () => importInput.current?.click() }, t('settings.import')),
              h('input', {
                ref: importInput, type: 'file', accept: 'application/json', disabled: busy, hidden: true,
                'aria-label': t('settings.import'), onChange: e => void importJson(e),
              }))),
          h('div', { className: 'bsch-settings-danger' },
            h('div', { className: 'bsch-settings-danger-copy' },
              h('div', { className: 'bsch-settings-danger-title' }, t('settings.clearTitle')),
              h('div', { className: 'bsch-hint', id: 'bsch-clear-warning' }, t('settings.clearAllHint'))),
            h('button', {
              className: 'bsch-btn is-danger', disabled: busy, 'aria-describedby': 'bsch-clear-warning',
              onClick: () => setConfirmClear(true),
            }, t('settings.clearAllConfirm')))),
        props.renderSlot('schedule.settings.blocks', {}),
        deleteCategory ? h(ConfirmDialog, {
          t, title: t('confirm.deleteTitle'), message: t('settings.deleteCategoryHint').replace('{name}', deleteCategory.name),
          confirmLabel: t('confirm.ok'), onCancel: () => setDeleteCategory(null),
          onConfirm: () => { editCategories(categories.filter(cat => cat.id !== deleteCategory.id)); setDeleteCategory(null) },
        }) : null,
        confirmClear ? h(ConfirmDialog, {
          t, title: t('settings.clearAll'), message: t('settings.clearAllHint'), confirmLabel: t('settings.clearAllConfirm'),
          onCancel: () => setConfirmClear(false), onConfirm: () => { setConfirmClear(false); void clearAll() },
        }) : null,
        status !== null ? h('div', { role: status.ok ? 'status' : 'alert', className: `bsch-hint bsch-settings-status${status.ok ? '' : ' bsch-error'}` }, status.text) : null)
    }
    return { SettingsSection }
  },
})
