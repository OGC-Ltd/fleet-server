import type { UserStatus } from '../../../generated/prisma/client.js'

declare global {
  namespace Express {
    interface Request {
      /** Populated by auth middleware after JWT verification + DB lookup. */
      user?: {
        id: string
        organisationId: string
        email: string
        fullName: string
        status: UserStatus
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
