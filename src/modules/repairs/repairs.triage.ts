export interface TriageUser {
  id: string
  fullName?: string | null
}

export interface TriageItem {
  id: string
  assignedToId: string | null
}

/**
 * Choose the least-loaded technician for a repair task.
 *
 * The rule is simple: among all active operators in the organisation, select
 * the one with the fewest currently assigned open items; ties are broken by
 * name so the choice is deterministic.
 */
export function chooseTechnicianForTriage<T extends TriageUser, I extends TriageItem>(
  users: T[],
  openItems: I[],
  excludeUserId?: string,
): string | null {
  const candidates = users.filter((u) => u.id !== excludeUserId)
  if (candidates.length === 0) return null

  const counts = new Map<string, number>()
  for (const item of openItems) {
    if (!item.assignedToId) continue
    if (item.assignedToId === excludeUserId) continue
    counts.set(item.assignedToId, (counts.get(item.assignedToId) ?? 0) + 1)
  }

  return [...candidates].sort((a, b) => {
    const diff = (counts.get(a.id) ?? 0) - (counts.get(b.id) ?? 0)
    if (diff !== 0) return diff
    return (a.fullName ?? '').localeCompare(b.fullName ?? '')
  })[0]?.id ?? null
}
