import { vi } from 'vitest'
import { mockDeep, mockReset } from 'vitest-mock-extended'
import type { PrismaClient } from '../../../generated/prisma/client.js'

export const prismaMock = mockDeep<PrismaClient>()

// Re-exported so tests can import { prisma } from '../../src/lib/prisma' and get the mock
export const prisma = prismaMock
export const connectDB = vi.fn().mockResolvedValue(undefined)
export const disconnectDB = vi.fn().mockResolvedValue(undefined)

// Call this in each test's beforeEach to get a clean slate
export function resetPrismaMock() {
  mockReset(prismaMock)
  // Array-form $transaction: forward each promise so individual method mocks work.
  // Callback form hands the callback the mock itself, the way a real interactive
  // transaction hands it a client — code that does `tx.$queryRaw(...)` inside a
  // transaction is otherwise calling a method on undefined.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.$transaction as any).mockImplementation(
    (input: unknown) =>
      Array.isArray(input)
        ? Promise.all(input as Promise<unknown>[])
        : (input as (tx: unknown) => unknown)(prismaMock),
  )
}
