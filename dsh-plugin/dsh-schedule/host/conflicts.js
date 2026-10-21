/** Half-open interval overlap detection for every calendar entry. */
const instant = value => {
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) throw new Error(`invalid datetime: ${value}`)
  return time
}

export function findConflicts(candidate, { entries }) {
  const start = instant(candidate.start)
  const end = instant(candidate.end)
  return entries.filter(entry => entry.id !== candidate.id
    && start < instant(entry.end) && instant(entry.start) < end)
    .map(entry => ({
      with: 'entry',
      title: entry.title,
      time: `${entry.start} – ${entry.end}`,
      reason: `与既有条目「${entry.title}」时间重叠（${entry.start} – ${entry.end}）`,
    }))
}
