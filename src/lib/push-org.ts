/**
 * The organisation a push is about, on the push itself (operator, 10 Nov 2026:
 * "the push notification they should also include the logo of the specified
 * organization associated with").
 *
 * The logo is the web app's: new-ui serves each organisation's mark at
 * /org-marks/<code>.png, and its service worker falls back to the Rai mark
 * when that file is not there, so an organisation without artwork still gets
 * a notification with an icon. The code also travels in `data.orgCode`, which
 * is how the in-app toast finds the same mark.
 */

import { prisma } from './prisma.js'
import { logger } from './logger.js'
import type { PushPayload } from '../modules/notifications/notifications.service.js'

export const orgMarkIcon = (code: string): string => `/org-marks/${code.trim().toLowerCase()}.png`

/** The organisation a payload names, when its caller did not pass one. */
export function payloadOrgId(payload: PushPayload): string | null {
  const id = payload.data?.orgId
  return typeof id === 'string' && id ? id : null
}

/**
 * The payload with its organisation's logo as the icon and the code in its
 * data. Unchanged when no organisation is named or its code is unknown.
 */
export function withOrganisation(payload: PushPayload, orgId: string | null, code: string | null): PushPayload {
  if (!orgId || !code) return payload
  return {
    ...payload,
    icon: orgMarkIcon(code),
    data: { ...(payload.data ?? {}), orgId, orgCode: code },
  }
}

/** Organisation codes by id. A code is fixed once an organisation exists, so this never expires. */
const codes = new Map<string, string | null>()

export async function orgCodeOf(orgId: string): Promise<string | null> {
  if (codes.has(orgId)) return codes.get(orgId) ?? null
  try {
    const org = await prisma.organisation.findUnique({ where: { id: orgId }, select: { code: true } })
    const code = org?.code ?? null
    codes.set(orgId, code)
    return code
  } catch (err) {
    // Not remembered: the next push asks again rather than going without its logo for good
    logger.warn({ err, orgId }, 'push: could not read the organisation code for the logo')
    return null
  }
}

/** The payload stamped with its organisation, read from the database once per organisation. */
export async function stampOrganisation(payload: PushPayload, orgId?: string | null): Promise<PushPayload> {
  const id = orgId ?? payloadOrgId(payload)
  return id ? withOrganisation(payload, id, await orgCodeOf(id)) : payload
}
