/**
 * Toasts: the short notices the web app stacks in its corner (operator,
 * 10 Nov 2026: "the notification for unauthorized stops and all the push
 * notification populated as a toast should be server generated").
 *
 * Made here and sent down the dashboard stream (`toast` frames, lib/sse), so
 * every open tab shows the same notice the server decided on. The browser only
 * draws them: first in, first out, each for 8 seconds.
 */

import { randomUUID } from 'node:crypto'
import { connectedDashboardUsers, emitDashboardToast, emitToUsers } from './sse.js'
import { canReachOrg, resolveSubject, vehicleScopeIn } from './authz/subject.js'
import { logger } from './logger.js'
import { env } from '../config/env.js'

export type ToastLevel = 'info' | 'warning' | 'critical'

export interface Toast {
  id: string
  /** 'stop' carries a stop-watch flag in `data`; 'push' is a web push's words. */
  kind: 'stop' | 'push'
  level: ToastLevel
  title: string
  body: string
  at: string
  orgId: string | null
  /** Top level so a viewer scoped to some units hears only theirs (lib/sse visibleTo). */
  vehicleId: string | null
  data: Record<string, unknown>
}

export function makeToast(t: Omit<Toast, 'id' | 'at' | 'orgId' | 'vehicleId' | 'data'> & Partial<Pick<Toast, 'orgId' | 'vehicleId' | 'data'>>): Toast {
  return { id: randomUUID(), at: new Date().toISOString(), orgId: null, vehicleId: null, data: {}, ...t }
}

/** A toast to these people, in every tab they have open. */
export function toastUsers(userIds: Iterable<string>, toast: Toast): number {
  return emitToUsers(userIds, 'toast', toast)
}

/** A toast to everyone looking at this organisation's map now. */
export function toastOrg(orgId: string, toast: Toast): void {
  emitDashboardToast(orgId, toast)
}

/**
 * The people connected now who may see this organisation (and, when one is
 * named, this unit), wherever they are looking: a Menengai stop reaches a
 * Menengai member who has Sukari open.
 */
export async function connectedUsersReaching(orgId: string, vehicleId?: string | null): Promise<string[]> {
  const out: string[] = []
  await Promise.all([...connectedDashboardUsers()].map(async (userId) => {
    try {
      const subject = await resolveSubject(userId)
      if (!canReachOrg(subject, orgId)) return
      // As requireOrgAccess: the scope narrows only while AUTHZ_ENFORCE is on
      const scope = env.AUTHZ_ENFORCE ? vehicleScopeIn(subject, orgId) : null
      if (scope && (!vehicleId || !scope.has(vehicleId))) return
      out.push(userId)
    } catch (err) {
      logger.debug({ err, userId }, 'toasts: could not resolve a connected user')
    }
  }))
  return out
}

/** A web push's words as a toast. */
export function pushToast(payload: { title: string; body: string; data?: Record<string, unknown> }, orgId?: string | null): Toast {
  const d = payload.data ?? {}
  const sev = String(d.severity ?? '').toUpperCase()
  const level: ToastLevel = d.critical === true || sev === 'CRITICAL' || sev === 'HIGH' ? 'critical' : sev === 'MEDIUM' || sev === 'WARNING' ? 'warning' : 'info'
  return makeToast({
    kind: 'push',
    level,
    title: payload.title,
    body: payload.body,
    orgId: orgId ?? (typeof d.orgId === 'string' ? d.orgId : null),
    vehicleId: typeof d.vehicleId === 'string' ? d.vehicleId : null,
    data: d,
  })
}
