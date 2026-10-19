/**
 * Pure week-grid math (docs/10 P3/P8): the 04:00–28:00 display day, the
 * grid-day bucketing rule, the today anchor, hour-label rows, and overlap
 * lane layout. No React, no DOM — WeekGrid renders what this computes.
 *
 * The one rule everywhere: an instant before 04:00 belongs to the previous
 * display day, drawn at +1440 minutes (a 01:00 entry sits at the bottom of
 * yesterday's column, under the 23:00 day boundary).
 */
window.__ModuleLoader__.load({
  id: '@buaaer/dsh-schedule/client.gridmath.js',
  factory: (require) => {
    const core = require('@buaaer/dsh-schedule/client.core.js')
    const { addDays, dateKey, pad2 } = core

    /** Display day: 04:00 → next-day 04:00 (1440 minutes). */
    const DAY_START_MIN = 4 * 60
    const DAY_END_MIN = 28 * 60
    const DAY_SPAN_MIN = DAY_END_MIN - DAY_START_MIN
    const SNAP_MIN = 15

    /** Wall-clock minutes from midnight of an ISO instant. */
    const localMinutes = iso => {
      const date = new Date(iso)
      return date.getHours() * 60 + date.getMinutes()
    }

    /**
     * Wall-clock minutes mapped into the grid's coordinate space (the same
     * space DAY_START_MIN/DAY_END_MIN live in): a 01:30 instant yields
     * 1530 — 21.5h into the PREVIOUS display day, between its 23:00
     * boundary and 28:00 end.
     */
    const relMinutes = iso => {
      const minutes = localMinutes(iso)
      return minutes < DAY_START_MIN ? minutes + 1440 : minutes
    }

    /** Display-day key (`YYYY-MM-DD`) an ISO instant belongs to. */
    const gridDay = iso => {
      const minutes = localMinutes(iso)
      const day = dateKey(new Date(iso))
      return minutes < DAY_START_MIN ? addDays(day, -1) : day
    }

    /**
     * "Today" as a display-day anchor: before 04:00 the current moments
     * still belong to yesterday's grid day (docs/10 P8, adjustInitialDate).
     */
    const anchorToday = (now = new Date()) => {
      if (now.getHours() >= 4) return dateKey(now)
      const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
      return dateKey(yesterday)
    }

    const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']

    /** 1 (Mon) … 7 (Sun) of a `YYYY-MM-DD` key. */
    const dayOfWeek = dayKey => (new Date(dayKey + 'T12:00:00').getDay() + 6) % 7 + 1

    const isWeekend = dayKey => dayOfWeek(dayKey) >= 6

    /**
     * The 24 label rows from 04:00 to 28:00. `hour` is the display hour
     * (4…27); the original hides the 24:00 label and marks the 23:00 row's
     * bottom edge as the day boundary.
     */
    const HOUR_ROWS = Array.from({ length: DAY_SPAN_MIN / 60 }, (_, i) => {
      const hour = DAY_START_MIN / 60 + i
      return {
        hour,
        label: `${pad2(hour % 24)}:00`,
        hideLabel: hour === 24,
        dayBoundary: hour === 23,
      }
    })

    /**
     * Greedy lane layout for same-day blocks (docs/10 P4): cluster items
     * whose intervals overlap transitively, then give each cluster member
     * the first lane free at its start. Touching intervals (end === start)
     * share the column — half-open intervals do not collide.
     *
     * @param {object[]} items - `{ id, startMin, endMin }` in rel minutes.
     * @returns {Map<string, {lane: number, laneCount: number}>}
     */
    function laneLayout(items) {
      const sorted = [...items].sort((a, b) =>
        a.startMin - b.startMin || a.endMin - b.endMin)
      const result = new Map()
      let cluster = null
      let clusterEnd = -Infinity
      for (const item of sorted) {
        if (cluster === null || item.startMin >= clusterEnd) {
          cluster = { items: [item], laneEnds: [] }
          clusterEnd = item.endMin
        } else {
          cluster.items.push(item)
          clusterEnd = Math.max(clusterEnd, item.endMin)
        }
        let lane = cluster.laneEnds.findIndex(end => end <= item.startMin)
        if (lane === -1) {
          cluster.laneEnds.push(item.endMin)
          lane = cluster.laneEnds.length - 1
        } else {
          cluster.laneEnds[lane] = item.endMin
        }
        item._lane = lane
        item._cluster = cluster
      }
      for (const item of sorted) {
        result.set(item.id, { lane: item._lane, laneCount: item._cluster.laneEnds.length })
        delete item._lane
        delete item._cluster
      }
      return result
    }

    return {
      DAY_START_MIN, DAY_END_MIN, DAY_SPAN_MIN, SNAP_MIN,
      localMinutes, relMinutes, gridDay, anchorToday,
      WEEKDAY_LABELS, dayOfWeek, isWeekend, HOUR_ROWS,
      laneLayout,
    }
  },
})
