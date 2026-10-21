/** Future reminder moments for ordinary calendar entries. */
export const ENTRY_WINDOW_MS = 8 * 24 * 60 * 60 * 1000

export function deriveScheduleReminders({ entries, nowMs, examLeadMinutes, eventLeadMinutes }) {
  const out = []
  for (const entry of entries) {
    const startMs = Date.parse(entry.start)
    if (!Number.isFinite(startMs)) continue
    const lead = entry.remindLead ?? (entry.category === 'exam' ? examLeadMinutes : eventLeadMinutes)
    const atMs = startMs - lead * 60_000
    if (!(atMs > nowMs)) continue
    out.push({
      kind: 'entry', key: `entry-${entry.id}`, title: entry.title,
      category: entry.category, location: entry.location ?? null,
      at: new Date(atMs).toISOString(), start: entry.start, allDay: entry.allDay === true,
    })
  }
  return out.sort((a, b) => a.at.localeCompare(b.at))
}
