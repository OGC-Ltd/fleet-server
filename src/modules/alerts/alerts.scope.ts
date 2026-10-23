/**
 * Who may read which alerts on the Alerts page, across organisations.
 *
 * The page spans tenants, so the org-scoped middleware cannot answer this;
 * it is answered here, from the same subject the middleware reads. The rest
 * of the page's rules are alerts.rules.
 */

import { can, vehicleScopeIn, type Subject } from '../../lib/authz/subject.js'
import { ALERT_KINDS, type AlertKindSlug } from './alerts.rules.js'

/**
 * What reading each kind takes in an organisation. Existing readers retain
 * access through the fuel incident list and Speed tab permissions; `alerts:read`
 * grants the dedicated Alerts page without opening those broader resources.
 */
export const READ_PERMISSION: Record<AlertKindSlug, string> = {
  fuel: 'fuel_theft:read',
  speeding: 'analytics:read',
}

export interface OrgScope {
  orgId: string
  /** null = every vehicle in the organisation. Never empty: see alertScopes. */
  vehicleIds: string[] | null
  kinds: AlertKindSlug[]
}

/**
 * The organisations among `orgIds` this person may read alerts in, which
 * kinds, and over which vehicles.
 *
 * Enforced here rather than shadowed (the vehicle-lookup rule): the endpoint
 * is new and spans tenants, and being permissive would hand one tenant
 * another's alerts. An organisation with neither permission is dropped, and
 * so is a membership narrowed to no vehicle at all, which must not widen to
 * the whole fleet.
 */
export function alertScopes(subject: Subject, orgIds: string[]): OrgScope[] {
  const out: OrgScope[] = []
  for (const orgId of orgIds) {
    const canReadAllAlerts = can(subject, orgId, 'alerts:read')
    const kinds = ALERT_KINDS.filter((k) => canReadAllAlerts || can(subject, orgId, READ_PERMISSION[k]))
    if (kinds.length === 0) continue
    const scope = vehicleScopeIn(subject, orgId)
    if (scope && scope.size === 0) continue
    out.push({ orgId, vehicleIds: scope ? [...scope] : null, kinds })
  }
  return out
}
