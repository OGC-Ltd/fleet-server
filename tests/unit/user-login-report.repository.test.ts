import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/lib/prisma.js')

import { prismaMock } from '../helpers/prisma.mock.js'
import { findLoginReport } from '../../src/modules/users/user.repository.js'

const ORG = 'org_test'
const query = { from: '2026-10-01', to: '2026-10-07', page: 1, limit: 50 }

beforeEach(() => vi.clearAllMocks())

describe('findLoginReport', () => {
  it('applies reachable-system-user and group scope to counts and event rows', async () => {
    prismaMock.user.count.mockResolvedValueOnce(4).mockResolvedValueOnce(2)
    prismaMock.userLoginEvent.count.mockResolvedValue(1)
    prismaMock.userLoginEvent.findMany.mockResolvedValue([
      {
        id: 'login-1',
        loggedInAt: new Date('2026-10-02T10:00:00Z'),
        user: { id: 'user-1', fullName: 'Visible User', email: 'visible@example.com', groups: [{ group: { name: 'Group A' } }] },
      },
    ] as never)

    const report = await findLoginReport(
      ORG,
      query,
      { unscoped: false, groupIds: ['group-a'] },
    )

    expect(report).toMatchObject({
      total: 1,
      systemUsers: 4,
      everLoggedIn: 2,
      rows: [{ id: 'login-1', user: { id: 'user-1', groups: ['Group A'] } }],
    })
    const expectedGroup = { groups: { some: { groupId: { in: ['group-a'] } } } }
    expect(prismaMock.user.count).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ AND: expect.arrayContaining([expectedGroup]) }),
    }))
    expect(prismaMock.user.count).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({
        lastLoginAt: { not: null },
        AND: expect.arrayContaining([expectedGroup]),
      }),
    }))
    expect(prismaMock.userLoginEvent.count).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        user: { is: expect.objectContaining({ AND: expect.arrayContaining([expectedGroup]) }) },
      }),
    }))
    expect(prismaMock.userLoginEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        user: { is: expect.objectContaining({ AND: expect.arrayContaining([expectedGroup]) }) },
      }),
    }))
  })

  it('fails closed for a caller without groups', async () => {
    prismaMock.user.count.mockResolvedValue(0)
    prismaMock.userLoginEvent.count.mockResolvedValue(0)
    prismaMock.userLoginEvent.findMany.mockResolvedValue([])

    await findLoginReport(ORG, query, { unscoped: false, groupIds: [] })

    expect(prismaMock.userLoginEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        user: { is: expect.objectContaining({ AND: expect.arrayContaining([{ id: { in: [] } }]) }) },
      }),
    }))
  })
})
