/**
 * WeekGrid: a self-drawn 7-day × time-axis grid (R10 — no FullCalendar).
 * The display day is 04:00–28:00 (docs/10 P3); geometry math lives in
 * client.gridmath.js. The interaction model follows desktop (Windows)
 * conventions — press, drag and release are handled as separate phases,
 * so a plain click never becomes an edit and a drag never trails a click:
 *   - left click on an entry selects it; left double-click or right click
 *     opens the editor; left press-drag moves every selected entry
 *     (vertically or across day columns — exactly ±24h per column,
 *     15-min snap); pressing an unselected block drags just that block;
 *   - right click / right drag on empty grid creates the draft "ghost"
 *     block (a plain right click makes a 1-hour ghost) and always clears
 *     any ghost already on the field; right click on an entry or the
 *     ghost opens its editor; the native menu is suppressed;
 *   - course occurrences (neither an entry nor the ghost) never read as
 *     empty-grid space (no ghost, no marquee — R11-1). Their quick-edit
 *     gestures are deliberately disabled: left drag does not move them and
 *     the resize handle is not rendered. Right click / double click opens
 *     the per-occurrence editor, which writes a manual exception instead
 *     of touching the synced weekly rule;
 *   - left press-drag on empty grid rubber-band SELECTS the entry blocks
 *     it touches; a plain left click on empty clears the selection;
 *   - any gesture unrelated to the ghost destroys it; a single left click
 *     on the ghost destroys it only after a short window has passed
 *     without a second press (a double-click in that window opens the
 *     editor instead);
 *   - Delete removes the selection; Escape clears ghost and selection;
 *   - drag a block's bottom edge to resize (docs/10 §2 item 5);
 *   - click a header cell to move the window anchor to that day.
 */
window.__ModuleLoader__.load({
  id: '@lidozs55/dsh-schedule/client.weekgrid.js',
  factory: (require) => {
    const core = require('@lidozs55/dsh-schedule/client.core.js')
    const grid = require('@lidozs55/dsh-schedule/client.gridmath.js')
    const { React, CATEGORY_TOKEN, addDays, dateToZonedIso } = core
    const { useState, useEffect, useRef, useMemo } = React
    const {
      DAY_START_MIN, DAY_END_MIN, DAY_SPAN_MIN, SNAP_MIN, relMinutes, gridDay,
      WEEKDAY_LABELS, dayOfWeek, isWeekend, HOUR_ROWS, laneLayout,
    } = grid
    const h = React.createElement

    const PX_PER_MIN = 1
    const GRID_HEIGHT = DAY_SPAN_MIN * PX_PER_MIN
    // A lone left click on the ghost waits this long for a second press
    // (double-click) before the draft is destroyed.
    const GHOST_CLICK_MS = 350

    /** Minutes at `clientY`, snapped to the grid's 15-minute lattice. */
    const minutesAt = (rect, clientY) =>
      DAY_START_MIN + Math.floor((clientY - rect.top) / PX_PER_MIN / SNAP_MIN) * SNAP_MIN

    const clampToDay = minutes => Math.min(Math.max(minutes, DAY_START_MIN), DAY_END_MIN)
    const snapDelta = dy => Math.round(dy / PX_PER_MIN / SNAP_MIN) * SNAP_MIN

    function EventBlock({ block, isSelected, onResizeStart }) {
      const isCourse = block.kind === 'course'
      const share = block.laneCount > 1 ? 100 / block.laneCount : 100
      return h('div', {
        className: [
          'bsch-block',
          isCourse ? 'is-course' : '',
          block.done ? 'is-done' : '',
          isSelected ? 'is-selected' : '',
          block.dragging ? 'is-dragging' : '',
          block.canceled ? 'is-canceled' : '',
        ].filter(Boolean).join(' '),
        'data-kind': block.kind,
        ...(block.kind === 'entry' ? { 'data-entry-id': block.id } : {}),
        ...(block.kind === 'course' ? { 'data-course-key': block.courseKey } : {}),
        style: {
          top: `${block.top}px`,
          height: `${Math.max(14, block.height - 2)}px`,
          left: `calc(${block.lane * share}% + 1px)`,
          width: `calc(${share}% - 2px)`,
          '--bsch-block-color': CATEGORY_TOKEN[block.category] ?? CATEGORY_TOKEN.other,
          ...(block.translate !== null
            ? { transform: `translate(${block.translate.x}px, ${block.translate.y}px)` }
            : {}),
          ...(block.resizeTo !== null ? { height: `${Math.max(14, block.resizeTo - 2)}px` } : {}),
        },
        title: `${block.title} ${block.timeLabel}`,
      },
      h('div', { className: 'bsch-block-title' }, block.title),
      block.height >= 32 ? h('div', { className: 'bsch-block-sub' }, block.timeLabel) : null,
      block.height >= 48 && block.subtitle ? h('div', { className: 'bsch-block-sub' }, block.subtitle) : null,
      isCourse ? null : h('div', {
        className: 'bsch-block-resize',
        onPointerDown: event => {
          event.stopPropagation()
          onResizeStart(block, event)
        },
      }))
    }

    /** The pending draft block (P2): translucent; double-click/right-click opens it. */
    function GhostBlock({ ghost, t }) {
      const top = (ghost.startMin - DAY_START_MIN) * PX_PER_MIN
      const height = Math.max(14, (ghost.endMin - ghost.startMin) * PX_PER_MIN - 2)
      return h('div', {
        className: 'bsch-block is-ghost',
        style: { top: `${top}px`, height: `${height}px` },
        title: t('grid.newEvent'),
      }, h('div', { className: 'bsch-block-title' }, t('grid.newEvent')))
    }

    /**
     * @param {object} props - `{ t, timer, weekStart, occurrences, entries,
     *   completedTaskIds, onEditEntry, onEditCourse, onCreateAt, onMoveItems,
     *   onDeleteEntries, onJumpTo }` — move/delete take one item or many
     *   through the same single props (the host API is natively multi-item);
     *   course occurrences open a per-occurrence editor via `onEditCourse`
     *   (drag/resize stay disabled so a week's class is not moved by accident).
     */
    function WeekGrid(props) {
      const { t, timer, weekStart, occurrences, entries, completedTaskIds } = props
      // `pendingMove` is the optimistic time override shown from the moment
      // the pointer is released until the refreshed snapshot arrives. Without
      // it the block snapped back to its old slot for one or two frames
      // (drag release -> host write -> snapshot round-trip).
      const [pendingMove, setPendingMove] = useState(() => new Map())
      // nowMin/nowDay tick together: at 02:00 the now-line belongs to
      // yesterday's column (the display day runs to 04:00).
      const [now, setNow] = useState(() => new Date().toISOString())
      const [drag, setDrag] = useState(null)     // move preview `{ ids, deltaMin, dx }`
      const [resize, setResize] = useState(null) // bottom-edge grow preview
      const [band, setBand] = useState(null)     // right-button draft band
      const [ghost, setGhost] = useState(null)   // persisted draft block
      const [selected, setSelected] = useState(() => new Set()) // entry ids
      const [marquee, setMarquee] = useState(null) // `{ left, top, width, height }` px
      const gridRef = useRef(null)
      const ghostRef = useRef(null)
      const ghostTimer = useRef(null)
      const rightPress = useRef(null)

      useEffect(() => { ghostRef.current = ghost }, [ghost])

      useEffect(() => {
        if (!timer) return undefined
        return timer.interval(() => setNow(new Date().toISOString()), 60_000)
      }, [timer])

      // Ghost and selection are drafts for THIS week: a jump discards both.
      useEffect(() => {
        setGhost(null)
        setSelected(new Set())
        setPendingMove(new Map())
      }, [weekStart])

      const clearGhostTimer = () => {
        if (ghostTimer.current !== null) {
          clearTimeout(ghostTimer.current)
          ghostTimer.current = null
        }
      }

      const scheduleGhostDestroy = () => {
        clearGhostTimer()
        ghostTimer.current = setTimeout(() => {
          ghostTimer.current = null
          setGhost(null)
        }, GHOST_CLICK_MS)
      }

      const entriesById = useMemo(() => new Map(entries.map(entry => [entry.id, entry])), [entries])

      // Drop a pending preview once the real row carries the new times (or
      // the row vanished). Failed moves are dropped by the onMoveItems result.
      useEffect(() => {
        if (pendingMove.size === 0) return
        setPendingMove(prev => {
          let changed = false
          const next = new Map(prev)
          for (const [id, target] of prev) {
            const row = entriesById.get(id)
            if (row === undefined || (row.start === target.start && row.end === target.end)) {
              next.delete(id)
              changed = true
            }
          }
          return changed ? next : prev
        })
      }, [entriesById, pendingMove])
      // An overridden occurrence has a stable override id; a plain projected
      // one is identified by courseId+start (same key the block carries).
      const occurrencesByKey = useMemo(() =>
        new Map(occurrences.map(item => [
          item.overrideId ?? `${item.courseId}@${item.start}`, item,
        ])), [occurrences])
      // Escape clears drafts; Delete removes the selection (Windows).
      useEffect(() => {
        const onKey = event => {
          if (event.key === 'Escape') {
            setGhost(null)
            setSelected(new Set())
            return
          }
          if (event.key !== 'Delete') return
          if (event.target.closest?.('input, textarea, select')) return
          if (selected.size > 0) {
            const blocks = [...selected]
              .map(id => entriesById.get(id))
              .filter(Boolean)
              .map(raw => ({ id: raw.id, raw }))
            if (blocks.length > 0) props.onDeleteEntries(blocks)
            setSelected(new Set())
          } else if (ghostRef.current !== null) {
            setGhost(null)
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [selected, entriesById, props.onDeleteEntries])

      const days = useMemo(() =>
        Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart])

      const nowDay = gridDay(now)
      const nowMin = relMinutes(now)

      const completed = useMemo(() => new Set(completedTaskIds ?? []), [completedTaskIds])
      const entryTaskDone = useMemo(() => {
        const map = new Map()
        for (const entry of entries) {
          if (entry.taskId && completed.has(entry.taskId)) map.set(entry.id, true)
        }
        return map
      }, [entries, completed])

      // Bucket by DISPLAY day (P3): a 01:00 entry lands in yesterday's column.
      const blocksByDay = useMemo(() => {
        const byDay = new Map(days.map(day => [day, []]))
        // Bucket by the pending (post-drop) time when there is one, so a
        // cross-column drag lands in the target column immediately.
        const add = (item, kind, view = item) => {
          const key = gridDay(view.start)
          if (byDay.has(key)) byDay.get(key).push({ item, kind })
        }
        for (const occurrence of occurrences) add(occurrence, 'course')
        for (const entry of entries) add(entry, 'entry', pendingMove.get(entry.id) ?? entry)
        return byDay
      }, [days, occurrences, entries, pendingMove])

      // Column geometry is frozen at grab time; pointer x picks the target day.
      const cellRects = () =>
        [...gridRef.current.querySelectorAll('.bsch-daycell')].map(el => el.getBoundingClientRect())
      const gridRect = () => gridRef.current.getBoundingClientRect()

      const markPending = items => {
        setPendingMove(prev => {
          const next = new Map(prev)
          for (const item of items) next.set(item.id, item.after)
          return next
        })
      }
      const clearPending = ids => {
        setPendingMove(prev => {
          let changed = false
          const next = new Map(prev)
          for (const id of ids) {
            if (next.delete(id)) changed = true
          }
          return changed ? next : prev
        })
      }
      // Resolve `onMoveItems` and roll back only the rows the host rejected
      // (conflicts land in the overwrite dialog); successful rows keep the
      // preview until the refreshed snapshot matches it.
      const settlePending = (items, ids) => {
        Promise.resolve()
          .then(() => props.onMoveItems(items))
          .then(result => {
            const failed = result?.failedIds ?? []
            if (failed.length > 0) clearPending(failed)
          })
          .catch(() => clearPending(ids))
      }

      // -- gesture: move entries (left press on an entry block) -----------------
      const startEntryDrag = (id, event, dayIndex) => {
        const ids = selected.has(id) ? [...selected] : [id]
        const origin = { y: event.clientY, day: dayIndex }
        const cells = cellRects()
        const dayAt = clientX => {
          const idx = cells.findIndex(rect => clientX >= rect.left && clientX < rect.right)
          return idx === -1 ? origin.day : idx
        }
        const onMove = moveEvent => {
          const deltaMin = snapDelta(moveEvent.clientY - origin.y)
          const dayShift = dayAt(moveEvent.clientX) - origin.day
          setDrag({ ids, deltaMin, dx: dayShift * (cells[0]?.width ?? 0) })
        }
        const onUp = upEvent => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          const deltaMin = snapDelta(upEvent.clientY - origin.y)
          const dayShift = dayAt(upEvent.clientX) - origin.day
          setDrag(null)
          if (deltaMin !== 0 || dayShift !== 0) {
            // Exactly ±24h per column plus the vertical delta: clock time
            // is preserved (this zone has no DST).
            const shiftMs = (dayShift * 1440 + deltaMin) * 60_000
            const items = ids
              .map(entryId => entriesById.get(entryId))
              .filter(Boolean)
              .map(raw => ({
                id: raw.id,
                raw,
                before: { start: raw.start, end: raw.end },
                after: {
                  start: dateToZonedIso(new Date(new Date(raw.start).getTime() + shiftMs)),
                  end: dateToZonedIso(new Date(new Date(raw.end).getTime() + shiftMs)),
                },
              }))
            if (items.length > 0) {
              markPending(items)
              settlePending(items, ids)
            }
          } else {
            setSelected(new Set([id]))
          }
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }

      // -- gesture: move the ghost draft (left press on it) ---------------------
      const startGhostDrag = (event, dayIndex) => {
        const start = { ...ghostRef.current }
        const originY = event.clientY
        const cells = cellRects()
        const dayAt = clientX => {
          const idx = cells.findIndex(rect => clientX >= rect.left && clientX < rect.right)
          return idx === -1 ? start.day : idx
        }
        let moved = false
        const onMove = moveEvent => {
          if (!moved && Math.abs(moveEvent.clientY - originY) <= 3) return
          moved = true
          const deltaMin = snapDelta(moveEvent.clientY - originY)
          const dayShift = dayAt(moveEvent.clientX) - dayIndex
          const day = Math.min(Math.max(start.day + dayShift, 0), 6)
          const startMin = clampToDay(start.startMin + deltaMin)
          const span = start.endMin - start.startMin
          setGhost(current => current === null ? current
            : { day, startMin, endMin: Math.min(startMin + span, DAY_END_MIN) })
        }
        const onUp = () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          // A lone left click is not a ghost gesture: destroy the draft
          // unless a second press (double-click) arrives inside the window.
          if (!moved) scheduleGhostDestroy()
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }

      const startResize = (block, event) => {
        if (drag !== null || resize !== null) return
        event.preventDefault()
        const origin = { y: event.clientY, endMin: relMinutes(block.end), startMin: relMinutes(block.start), end: block.end }
        const onMove = moveEvent => {
          const endMin = Math.max(origin.startMin + SNAP_MIN,
            snapDelta(moveEvent.clientY - origin.y) + origin.endMin)
          setResize({ id: block.id, endMin })
        }
        const onUp = upEvent => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          const endMin = Math.max(origin.startMin + SNAP_MIN,
            snapDelta(upEvent.clientY - origin.y) + origin.endMin)
          setResize(null)
          if (endMin !== origin.endMin) {
            const deltaMs = (endMin - origin.endMin) * 60_000
            const items = [{
              id: block.id,
              raw: block.raw,
              before: { start: block.start, end: block.end },
              after: {
                start: block.start,
                end: dateToZonedIso(new Date(new Date(block.end).getTime() + deltaMs)),
              },
            }]
            markPending(items)
            settlePending(items, [block.id])
          }
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }

      // -- gesture: right button (ghost creation / editor) ----------------------
      const onRightMove = moveEvent => {
        const press = rightPress.current
        if (press === null || press.type !== 'empty') return
        if (!press.moved && Math.abs(moveEvent.clientY - press.y) <= 3) return
        press.moved = true
        const currentMin = clampToDay(minutesAt(gridRect(), moveEvent.clientY))
        press.latest = {
          startMin: Math.min(press.anchorMin, currentMin),
          endMin: Math.max(press.anchorMin + SNAP_MIN, currentMin),
        }
        setBand({ day: press.day, ...press.latest })
      }

      const onRightUp = () => {
        window.removeEventListener('pointermove', onRightMove)
        window.removeEventListener('pointerup', onRightUp)
        const press = rightPress.current
        rightPress.current = null
        if (press === null) return
        if (press.type === 'empty') {
          // A plain right click makes a 1-hour ghost; a right drag makes a
          // band. Either way every earlier ghost is already gone (cleared
          // at press — a right gesture always clears the field).
          const range = press.moved && press.latest !== null
            ? press.latest
            : { startMin: press.anchorMin, endMin: press.anchorMin + 60 }
          setGhost({ day: press.day, startMin: range.startMin, endMin: Math.min(range.endMin, DAY_END_MIN) })
          setBand(null)
        } else if (press.type === 'entry') {
          const raw = entriesById.get(press.id)
          if (raw !== undefined) {
            setSelected(new Set([press.id]))
            props.onEditEntry({ raw })
          }
        } else if (press.type === 'ghost') {
          const current = ghostRef.current
          if (current !== null) {
            props.onCreateAt(days[current.day], current.startMin, current.endMin)
            setGhost(null)
          }
        }
      }

      // -- gesture: rubber-band selection (left press on empty) -----------------
      const startMarquee = event => {
        const rect = gridRect()
        const origin = { x: event.clientX, y: event.clientY }
        let moved = false
        const box = (x0, y0, x1, y1) => {
          const left = Math.min(Math.max(Math.min(x0, x1) - rect.left, 0), rect.width)
          const right = Math.min(Math.max(Math.max(x0, x1) - rect.left, 0), rect.width)
          const top = Math.min(Math.max(Math.min(y0, y1) - rect.top, 0), rect.height)
          const bottom = Math.min(Math.max(Math.max(y0, y1) - rect.top, 0), rect.height)
          return { left, top, width: right - left, height: bottom - top }
        }
        const onMove = moveEvent => {
          if (!moved && Math.abs(moveEvent.clientX - origin.x) <= 4
            && Math.abs(moveEvent.clientY - origin.y) <= 4) return
          moved = true
          setMarquee(box(origin.x, origin.y, moveEvent.clientX, moveEvent.clientY))
        }
        const onUp = upEvent => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          setMarquee(null)
          if (!moved) return // plain click: selection was cleared at press
          // Hit-test in viewport coordinates against the live block rects
          // (the marquee box above is grid-local and only used for display).
          const vx0 = Math.min(origin.x, upEvent.clientX)
          const vx1 = Math.max(origin.x, upEvent.clientX)
          const vy0 = Math.min(origin.y, upEvent.clientY)
          const vy1 = Math.max(origin.y, upEvent.clientY)
          const hits = new Set()
          for (const el of gridRef.current.querySelectorAll('.bsch-block[data-kind="entry"]')) {
            const r = el.getBoundingClientRect()
            if (r.left < vx1 && r.right > vx0 && r.top < vy1 && r.bottom > vy0) {
              hits.add(el.dataset.entryId)
            }
          }
          setSelected(hits)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }

      const onGridPointerDown = event => {
        if (event.button !== 0 && event.button !== 2) return
        if (event.target.closest?.('.bsch-block-resize')) return
        event.preventDefault()
        const blockEl = event.target.closest?.('.bsch-block')
        const isGhost = blockEl !== null && blockEl.classList.contains('is-ghost')
        const isEntry = blockEl !== null && blockEl.dataset.kind === 'entry'
        const cells = cellRects()
        const dayIndex = cells.findIndex(rect => event.clientX >= rect.left && event.clientX < rect.right)
        clearGhostTimer()

        if (event.button === 2) {
          if (isGhost) {
            rightPress.current = { type: 'ghost' }
          } else if (isEntry) {
            setGhost(null) // a right gesture on an entry is unrelated to the draft
            rightPress.current = { type: 'entry', id: blockEl.dataset.entryId }
          } else if (blockEl !== null) {
            // Course occurrence: opens the per-occurrence editor; never
            // falls through to "empty" (which would create a ghost).
            setGhost(null)
            const occurrence = occurrencesByKey.get(blockEl.dataset.courseKey ?? '')
            if (occurrence !== undefined) props.onEditCourse(occurrence)
          } else if (dayIndex !== -1) {
            // A right gesture always clears the field first; the band (or
            // the plain-click ghost) then starts from this very point.
            setGhost(null)
            setSelected(new Set())
            const anchorMin = clampToDay(minutesAt(gridRect(), event.clientY))
            rightPress.current = { type: 'empty', day: dayIndex, y: event.clientY, anchorMin, moved: false, latest: null }
            setBand({ day: dayIndex, startMin: anchorMin, endMin: anchorMin + SNAP_MIN })
          }
          if (rightPress.current !== null) {
            window.addEventListener('pointermove', onRightMove)
            window.addEventListener('pointerup', onRightUp)
          }
          return
        }

        if (isGhost) {
          startGhostDrag(event, dayIndex)
        } else if (isEntry) {
          setGhost(null) // a left gesture on an entry is unrelated to the draft
          startEntryDrag(blockEl.dataset.entryId, event, dayIndex)
        } else if (blockEl !== null) {
          // Course occurrence: quick edits (drag position / drag duration)
          // are intentionally disabled; click is inert, the editor opens
          // via double click or right click.
          setGhost(null)
        } else if (dayIndex !== -1) {
          // Left press on empty: clear everything, arm the marquee.
          setGhost(null)
          setSelected(new Set())
          startMarquee(event)
        } else {
          setGhost(null)
          setSelected(new Set())
        }
      }

      const onGridDblClick = event => {
        if (event.target.closest?.('.bsch-block-resize')) return
        const blockEl = event.target.closest?.('.bsch-block')
        if (blockEl === null || blockEl.classList.contains('is-band')) return
        clearGhostTimer()
        if (blockEl.classList.contains('is-ghost')) {
          const current = ghostRef.current
          if (current !== null) {
            props.onCreateAt(days[current.day], current.startMin, current.endMin)
            setGhost(null)
          }
        } else if (blockEl.dataset.kind === 'entry') {
          setGhost(null)
          const raw = entriesById.get(blockEl.dataset.entryId)
          if (raw !== undefined) props.onEditEntry({ raw })
        } else if (blockEl.dataset.courseKey !== undefined) {
          setGhost(null)
          const occurrence = occurrencesByKey.get(blockEl.dataset.courseKey)
          if (occurrence !== undefined) props.onEditCourse(occurrence)
        }
      }

      // Right-button logic runs entirely on pointerdown/up; contextmenu only
      // keeps the native menu out of the grid.
      const onGridContextMenu = event => event.preventDefault()

      // -- rendering -------------------------------------------------------------
      const renderBlocks = (day, dayIndex) => {
        const bucket = blocksByDay.get(day) ?? []
        // Effective times include the optimistic post-drop preview so lane
        // layout and block positions never fall back to the old slot.
        const times = item => pendingMove.get(item.id) ?? item
        const laid = laneLayout(bucket.map(({ item, kind }) => ({
          id: `${kind}:${item.id}`,
          startMin: relMinutes(times(item).start),
          endMin: relMinutes(times(item).end),
        })))
        return bucket.map(({ item, kind }) => {
          const id = `${kind}:${item.id}`
          const layout = laid.get(id)
          const view = times(item)
          // Clip into the display day; overnight tails past 04:00 fold away.
          const startMin = Math.max(DAY_START_MIN, relMinutes(view.start))
          const endMin = Math.min(DAY_END_MIN, Math.max(startMin, relMinutes(view.end)))
          if (endMin <= DAY_START_MIN || startMin >= DAY_END_MIN) return null
          const height = (endMin - startMin) * PX_PER_MIN
          const isDragging = drag !== null && drag.ids.includes(item.id)
          const isResizing = resize !== null && resize.id === item.id
          const title = item.title ?? item.courseName
          const block = {
            id: item.id,
            kind,
            category: kind === 'course' ? 'course' : item.category,
            ...(kind === 'course'
              ? { courseKey: item.overrideId ?? `${item.courseId}@${item.start}` }
              : {}),
            title: item.canceled ? `${title}（${t('course.canceled')}）` : title,
            subtitle: item.classroom || undefined,
            start: view.start,
            end: view.end,
            raw: item,
            canceled: kind === 'course' && item.canceled === true,
            top: (startMin - DAY_START_MIN) * PX_PER_MIN,
            height,
            lane: layout.lane,
            laneCount: layout.laneCount,
            timeLabel: `${view.start.slice(11, 16)}–${view.end.slice(11, 16)}`,
            done: kind === 'entry' && entryTaskDone.get(item.id) === true,
            dragging: isDragging || isResizing,
            translate: isDragging ? { x: drag.dx, y: drag.deltaMin * PX_PER_MIN } : null,
            resizeTo: isResizing ? (resize.endMin - startMin) * PX_PER_MIN : null,
          }
          return h('div', { key: id },
            h(EventBlock, {
              block,
              isSelected: kind === 'entry' && selected.has(item.id),
              onResizeStart: startResize,
            }))
        })
      }

      const hourRows = () => HOUR_ROWS.map((row, i) => h('div', {
        key: i,
        className: [
          'bsch-hour',
          row.dayBoundary ? 'is-dayboundary' : '',
          row.hideLabel ? 'is-nolabel' : '',
        ].filter(Boolean).join(' '),
      }))

      const gutter = () => HOUR_ROWS.map((row, i) => h('div', {
        key: i,
        className: `bsch-hour${row.hideLabel ? ' is-nolabel' : ''}`,
      }, row.hideLabel ? null : h('span', { className: 'bsch-hourlabel' }, row.label)))

      const todayIndex = days.indexOf(nowDay)
      const nowLine = todayIndex >= 0 && nowMin >= DAY_START_MIN && nowMin <= DAY_END_MIN
        ? h('div', {
            className: 'bsch-nowline',
            style: { top: `${(nowMin - DAY_START_MIN) * PX_PER_MIN}px` },
          })
        : null

      const headCells = days.map((day, i) => h('div', {
        key: day,
        className: i === todayIndex ? 'is-today' : undefined,
        onClick: () => { setGhost(null); setSelected(new Set()); props.onJumpTo(day) },
        title: t('grid.jumpTo'),
      }, `${day.slice(5)} ${WEEKDAY_LABELS[dayOfWeek(day) - 1]}`))

      const dayCells = days.map((day, i) => h('div', {
        key: day,
        className: `bsch-daycell${isWeekend(day) ? ' is-weekend' : ''}`,
      }, hourRows(), nowLine, renderBlocks(day, i),
        band !== null && band.day === i
          ? h('div', {
              className: 'bsch-block is-band',
              style: {
                top: `${(band.startMin - DAY_START_MIN) * PX_PER_MIN}px`,
                height: `${Math.max(4, (band.endMin - band.startMin) * PX_PER_MIN - 2)}px`,
              },
            })
          : null,
        ghost !== null && ghost.day === i
          ? h(GhostBlock, { ghost, t })
          : null))

      return h('div', { className: 'bsch-gridwrap' },
        h('div', { className: 'bsch-grid-head' }, h('div', null), headCells),
        h('div', {
          className: 'bsch-grid',
          ref: gridRef,
          style: { height: `${GRID_HEIGHT}px` },
          onPointerDown: onGridPointerDown,
          onDoubleClick: onGridDblClick,
          onContextMenu: onGridContextMenu,
        },
        h('div', null, gutter()), dayCells,
        marquee !== null
          ? h('div', {
              className: 'bsch-marquee',
              style: {
                left: `${marquee.left}px`,
                top: `${marquee.top}px`,
                width: `${marquee.width}px`,
                height: `${marquee.height}px`,
              },
            })
          : null))
    }

    return { WeekGrid }
  },
})
