import type { UserStatus } from '../../../generated/prisma/client.js'

declare global {
  namespace Express {
    interface Request {
      /** Populated by auth middleware after JWT verification + DB lookup. */
      user?: {
        id: string
        organisationId: string
        /** NULL for provider-synced drivers, who never sign in. */
        email: string | null
        fullName: string
        status: UserStatus
      }
      /**
       * Populated by the authorize middleware on org-scoped routes.
       *
       * `vehicleIds` is the row filter for this request. NULL means the whole
       * fleet; an EMPTY SET means nothing, which is the correct answer for a
       * membership narrowed to vehicles that no longer exist. Repositories must
       * distinguish the two - treating null as "none" blanks the map for every
       * unrestricted user, and treating empty as "all" hands a scoped operator
       * the entire fleet.
       */
      authz?: {
        userId: string
        orgId: string
        isPlatform: boolean
        vehicleIds: Set<string> | null
      }
      /** Populated by ingestAuth middleware for device-to-server telemetry push. */
      ingestOrg?: {
        id: string
        apiKeyId: string
      }
    }
  }
}

export {}
