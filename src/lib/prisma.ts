import { PrismaClient } from '../../generated/prisma/client.js'
import { PrismaPg } from '@prisma/adapter-pg'
import { env } from '../config/env.js'
import { logger } from './logger.js'

// Prisma v7 requires a driver adapter — @prisma/adapter-pg wraps the pg pool.
// The pooler URL (pgbouncer=true) is used for the pool; DIRECT_URL is used for migrations.
function createPrismaClient() {
  // max: bound the pg pool a little above the default (10) so the 30 s telemetry
  // poller and interactive API/SSE traffic don't starve each other for
  // connections over the remote pooler. Kept under Supabase's default pool size.
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL, max: 14 })
  return new PrismaClient({ adapter })
}

// Singleton prevents connection exhaustion during hot-reload in dev.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma = globalForPrisma.prisma ?? createPrismaClient()

if (env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}

export async function connectDB(): Promise<void> {
  await prisma.$connect()
  logger.info('Database connected')
}

export async function disconnectDB(): Promise<void> {
  await prisma.$disconnect()
  logger.info('Database disconnected')
}
