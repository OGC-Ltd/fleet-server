import { vi, afterEach } from 'vitest'

vi.mock('../src/lib/logger.ts', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}))

afterEach(() => {
  vi.clearAllMocks()
})
