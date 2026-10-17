/**
 * WeekGrid: a self-drawn 7-day × time-axis grid (R10 — no FullCalendar).
 * Course occurrences render as dashed blocks (read-only); entries drag
 * with 15-minute snapping and commit through the panel's write path.
 */
window.__ModuleLoader__.load({
  id: '@buaaer/dsh-schedule/client.weekgrid.js',
  factory: (require) => {
    const core = require('@buaaer/dsh-schedule/client.core.js')
    const { React, CATEGORY_TOKEN, isoDay, addDays, mondayOf, zonedAt } = core
    const { useState, useEffect, useRef, useMemo } = React
    const h = React.createElement

    const DAY_START_MIN = 6 * 60
    const DAY_END_MIN = 24 * 60
    const PX_PER_MIN = 1
    const GRID_HEIGHT = (DAY_END_MIN - DAY_START_MIN) * PX_PER_MIN
    const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

    const localMinutes = iso => {
      const date = new Date(iso)
      return date.getHours() * 60 + date.getMinutes()
    }
    function EventBlock({ block, onEdit, onDragStart }) {
      const isCourse = block.kind === 'course'
      return h('div', {
        className: [
          'bsch-block',
          isCourse ? 'is-course' : '',
          block.done ? 'is-done' : '',
          block.dragging ? 'is-dragging' : '',
        ].filter(Boolean).join(' '),
        style: {
          top: `${block.top}px`,
          height: `${Math.max(14, block.height - 2)}px`,
          '--bsch-block-color': CATEGORY_TOKEN[block.category] ?? CATEGORY_TOKEN.other,
        },
        onPointerDown: event => {
          if (isCourse) return
          onDragStart(block, event)
        },
        onClick: event => {
          event.stopPropagation()
          onEdit(block)
        },
        title: `${block.title} ${block.timeLabel}`,
      },
      h('div', { className: 'bsch-block-title' }, block.title),
      block.height >= 32 ? h('div', { className: 'bsch-block-sub' }, block.timeLabel) : null,
      block.height >= 48 && block.subtitle ? h('div', { className: 'bsch-block-sub' }, block.subtitle) : null)
    }

    /**
     * @param {object} props - `{ t, timer, weekStart, today, occurrences,
     *   entries, completedTaskIds, onEditEntry, onCreateAt, onMove }`.
     */
    function WeekGrid(props) {
      const { t, timer, weekStart, today, occurrences, entries, completedTaskIds } = props
      const [nowMin, setNowMin] = useState(localMinutes(new Date().toISOString()))
      const [drag, setDrag] = useState(null)
      const gridRef = useRef(null)

      useEffect(() => {
        if (!timer) return undefined
        return timer.interval(() => setNowMin(localMinutes(new Date().toISOString())), 60_000)
      }, [timer])

      const days = useMemo(() =>
        Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart])

      const completed = useMemo(() => new Set(completedTaskIds ?? []), [completedTaskIds])
      const entryTaskDone = useMemo(() => {
        const map = new Map()
        for (const entry of entries) {
          if (entry.taskId && completed.has(entry.taskId)) map.set(entry.id, true)
        }
        return map
      }, [entries, completed])

      const blocksByDay = useMemo(() => {
        const byDay = new Map(days.map(day => [day, []]))
        for (const occurrence of occurrences) {
          byDay.get(occurrence.day)?.push(occurrence)
        }
        for (const entry of entries) {
          const key = isoDay(entry.start)
          if (byDay.has(key)) byDay.get(key).push(entry)
        }
        return byDay
      }, [days, occurrences, entries])

      const startDrag = (block, event) => {
        if (drag !== null) return
        event.preventDefault()
        const origin = { y: event.clientY, start: block.start, end: block.end }
        const onMove = moveEvent => {
          const deltaMin = Math.round((moveEvent.clientY - origin.y) / PX_PER_MIN / 15) * 15
          if (deltaMin === 0 && !drag) return
          setDrag({ id: block.id, deltaMin })
        }
        const onUp = upEvent => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          const deltaMin = Math.round((upEvent.clientY - origin.y) / PX_PER_MIN / 15) * 15
          setDrag(null)
          if (deltaMin !== 0) {
            const shift = deltaMin * 60_000
            props.onMove(block, new Date(new Date(block.start).getTime() + shift), new Date(new Date(block.end).getTime() + shift))
          }
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }

      const renderBlocks = day => (blocksByDay.get(day) ?? []).map(item => {
        const kind = item.courseId !== undefined ? 'course' : 'entry'
        const startMin = Math.max(DAY_START_MIN, localMinutes(item.start))
        const endMin = Math.min(DAY_END_MIN, localMinutes(item.end))
        if (endMin <= DAY_START_MIN || startMin >= DAY_END_MIN) return null
        const block = {
          id: item.id,
          kind,
          category: kind === 'course' ? 'course' : item.category,
          title: item.title ?? item.courseName,
          subtitle: item.classroom || undefined,
          start: item.start,
          end: item.end,
          raw: item,
          top: (startMin - DAY_START_MIN) * PX_PER_MIN,
          height: Math.max((endMin - startMin) * PX_PER_MIN, 14),
          timeLabel: `${item.start.slice(11, 16)}–${item.end.slice(11, 16)}`,
          done: kind === 'entry' && entryTaskDone.get(item.id) === true,
          dragging: drag !== null && drag.id === item.id,
          deltaMin: drag !== null && drag.id === item.id ? drag.deltaMin : 0,
        }
        const style = block.deltaMin !== 0
          ? { transform: `translateY(${block.deltaMin * PX_PER_MIN}px)` }
          : undefined
        return h('div', { key: `${kind}-${item.id}`, style },
          h(EventBlock, { block, onEdit: props.onEditEntry, onDragStart: startDrag }))
      })

      const hourRows = () => Array.from({ length: (DAY_END_MIN - DAY_START_MIN) / 60 }, (_, i) =>
        h('div', { key: i, className: 'bsch-hour' }))

      const gutter = () => Array.from({ length: (DAY_END_MIN - DAY_START_MIN) / 60 }, (_, i) =>
        h('div', { key: i, className: 'bsch-hour' },
          h('span', { className: 'bsch-hourlabel' }, `${String(DAY_START_MIN / 60 + i).padStart(2, '0')}:00`)))

      const createAt = (day, event) => {
        const rect = gridRef.current.getBoundingClientRect()
        const minutes = DAY_START_MIN + Math.round((event.clientY - rect.top) / PX_PER_MIN / 15) * 15
        props.onCreateAt(day, Math.min(Math.max(minutes, DAY_START_MIN), DAY_END_MIN - 15))
      }

      const todayIndex = days.indexOf(today)
      const nowLine = todayIndex >= 0 && nowMin >= DAY_START_MIN && nowMin <= DAY_END_MIN
        ? h('div', {
            className: 'bsch-nowline',
            style: { top: `${(nowMin - DAY_START_MIN) * PX_PER_MIN}px` },
          })
        : null

      const headCells = days.map((day, i) => h('div', {
        key: day,
        className: i === todayIndex ? 'is-today' : undefined,
      }, `${day.slice(5)} ${WEEKDAYS[i]}`))

      const dayCells = days.map((day, i) => h('div', {
        key: day,
        className: `bsch-daycell${i >= 5 ? ' is-weekend' : ''}`,
        onDoubleClick: event => createAt(day, event),
        title: t('grid.newAt'),
      }, hourRows(), nowLine, renderBlocks(day)))

      return h('div', { className: 'bsch-gridwrap' },
        h('div', { className: 'bsch-grid-head' }, h('div', null), headCells),
        h('div', {
          className: 'bsch-grid',
          ref: gridRef,
          style: { height: `${GRID_HEIGHT}px` },
        }, h('div', null, gutter()), dayCells))
    }

    return { WeekGrid }
  },
})
