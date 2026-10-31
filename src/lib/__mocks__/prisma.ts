import { vi } from 'vitest'
import { mockDeep, mockReset } from 'vitest-mock-extended'
import { Prisma, type PrismaClient } from '../../../generated/prisma/client.js'

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
  // Raw queries default to NO ROWS, not to undefined. Postgres always answers a
  // SELECT with a result set, so `undefined` is a shape the real client can
  // never produce — leaving it unset made every caller that does the obvious
  // `rows.length` blow up in tests for a reason that could not happen in
  // production, and pushed defensive `?? []` into code that does not need it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.$queryRaw as any).mockResolvedValue([])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(prismaMock.$queryRawUnsafe as any).mockResolvedValue([])
  // Same reasoning for `findMany`: the real client always answers with an
  // array. Without this, every query a test did not think to stub came back
  // undefined and surfaced as a 500 from some unrelated `.map` — which is how
  // newer authorisation reads (user.authz, authz/subject) broke whole suites
  // whose subject had nothing to do with them.
  for (const model of Object.values(Prisma.ModelName)) {
    const delegate = model.charAt(0).toLowerCase() + model.slice(1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;((prismaMock as any)[delegate].findMany as any).mockResolvedValue([])
  }
}
