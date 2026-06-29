import { beforeEach } from 'vitest'
import { prismaMock, resetPrismaMock } from '../../src/lib/__mocks__/prisma.js'

export { prismaMock }

beforeEach(() => resetPrismaMock())
