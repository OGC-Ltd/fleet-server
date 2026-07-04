/**
 * Web Push service.
 *
 * Push subscriptions are stored in the `push_subscriptions` table so they
 * survive server restarts.  The VAPID keys must be set in .env:
 *
 *   VAPID_PUBLIC_KEY=<base64url>
 *   VAPID_PRIVATE_KEY=<base64url>
 *   VAPID_SUBJECT=mailto:admin@yourfleet.co.ke
 *
 * Generate a new key pair (run once, copy output to .env):
 *   node -e "const wp=require('web-push'); console.log(JSON.stringify(wp.generateVAPIDKeys(),null,2))"
 */

import { prisma } from '../../lib/prisma.js'
import { logger }  from '../../lib/logger.js'
import { initPushDispatcher, getPushDispatcher } from '../../lib/push-dispatcher.js'

// ─── VAPID initialisation ──────────────────────────────────────────────────
// The actual signing/encryption/delivery (webpush.sendNotification) runs on a
// dedicated worker thread — see push-dispatcher.ts / workers/push.worker-thread.ts.
// Nothing on the main thread imports `web-push` directly any more.

const PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  ?? ''
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? ''
const SUBJECT     = process.env.VAPID_SUBJECT     ?? 'mailto:fleet@sukari.co.ke'

if (PUBLIC_KEY && PRIVATE_KEY) {
  initPushDispatcher({ publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY, subject: SUBJECT })
  logger.info({ subject: SUBJECT }, 'Web Push VAPID keys configured (dispatch via worker thread)')
} else {
  logger.warn('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — Web Push is disabled')
}

// ─── push notification payload ─────────────────────────────────────────────

export interface PushPayload {
  title: string
  body:  string
  data?: Record<string, unknown>
  icon?: string
  badge?: string
  tag?:  string
}

// ─── subscription management ───────────────────────────────────────────────

export interface PushSubscriptionDto {
  endpoint: string
  keys: {
    p256dh: string
    auth:   string
  }
}

class PushService {
  get vapidPublicKey(): string {
    return PUBLIC_KEY
  }

  get isEnabled(): boolean {
    return Boolean(PUBLIC_KEY && PRIVATE_KEY)
  }

  async subscribe(
    orgId:      string,
    userId:     string | null,
    sub:        PushSubscriptionDto,
    userAgent?: string,
  ): Promise<void> {
    await prisma.pushSubscription.upsert({
      where:  { endpoint: sub.endpoint },
      create: {
        organisationId: orgId,
        userId:         userId ?? undefined,
        endpoint:       sub.endpoint,
        p256dh:         sub.keys.p256dh,
        auth:           sub.keys.auth,
        userAgent:      userAgent,
      },
      update: {
        organisationId: orgId,
        userId:         userId ?? undefined,
        p256dh:         sub.keys.p256dh,
        auth:           sub.keys.auth,
      },
    })
  }

  async unsubscribe(endpoint: string): Promise<void> {
    await prisma.pushSubscription.deleteMany({ where: { endpoint } })
  }

  async broadcastToOrg(orgId: string, payload: PushPayload): Promise<void> {
    if (!this.isEnabled) return

    const subs = await prisma.pushSubscription.findMany({
      where: { organisationId: orgId },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    })

    if (!subs.length) return

    const body = JSON.stringify(payload)
    const stale: string[] = []

    const dispatcher = getPushDispatcher()
    if (!dispatcher) return   // isEnabled guarantees this shouldn't happen, but stay defensive

    await Promise.allSettled(
      subs.map(async (sub) => {
        const result = await dispatcher.send({
          subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload: body,
          ttl: 60,
        })
        if (result.ok) return
        if (result.stale) {
          // Subscription expired / unregistered — clean it up
          stale.push(sub.id)
        } else {
          logger.warn({ err: result.errorMessage, endpoint: sub.endpoint }, 'Web Push delivery failed')
        }
      }),
    )

    if (stale.length) {
      await prisma.pushSubscription.deleteMany({ where: { id: { in: stale } } })
      logger.info({ count: stale.length }, 'Removed stale push subscriptions')
    }
  }
}

export const pushService = new PushService()
