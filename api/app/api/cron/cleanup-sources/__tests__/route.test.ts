import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const expired = {
    id: 'src_expired',
    userId: 'user_1',
    storagePath: 'goalcoach/uploads/user_1/photo.jpg',
    isDeleted: false,
  }
  const selected = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
  }
  selected.from.mockReturnValue(selected)
  selected.where.mockReturnValue(selected)
  selected.orderBy.mockReturnValue(selected)
  selected.limit.mockResolvedValue([expired])

  const deleteWhere = vi.fn().mockResolvedValue(undefined)
  const returning = vi.fn().mockResolvedValue([expired])
  const updateWhere = vi.fn(() => ({ returning }))
  const updateSet = vi.fn(() => ({ where: updateWhere }))

  return {
    expired,
    selected,
    deleteWhere,
    updateSet,
    deleteFile: vi.fn().mockResolvedValue(undefined),
    invalidateUser: vi.fn(),
  }
})

vi.mock('@/lib/db', () => ({
  db: {
    select: vi.fn(() => mocks.selected),
    update: vi.fn(() => ({ set: mocks.updateSet })),
    delete: vi.fn(() => ({ where: mocks.deleteWhere })),
  },
}))
vi.mock('@/lib/storage', () => ({ deleteFile: mocks.deleteFile }))
vi.mock('@/lib/cache', () => ({ invalidateUser: mocks.invalidateUser }))

import { NextRequest } from 'next/server'
import { GET } from '../route'

describe('GET /api/cron/cleanup-sources', () => {
  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', 'cron-test-secret')
    mocks.deleteFile.mockClear()
    mocks.invalidateUser.mockClear()
    mocks.deleteWhere.mockClear()
  })

  afterEach(() => vi.unstubAllEnvs())

  it('rejects requests without the cron bearer secret', async () => {
    const response = await GET(new NextRequest('http://localhost/api/cron/cleanup-sources'))
    expect(response.status).toBe(404)
    expect(mocks.deleteFile).not.toHaveBeenCalled()
  })

  it('removes expired unlinked objects and rows', async () => {
    const response = await GET(new NextRequest('http://localhost/api/cron/cleanup-sources', {
      headers: { authorization: 'Bearer cron-test-secret' },
    }))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ scanned: 1, deleted: 1, failed: 0 })
    expect(mocks.deleteFile).toHaveBeenCalledWith(mocks.expired.storagePath)
    expect(mocks.deleteWhere).toHaveBeenCalled()
    expect(mocks.invalidateUser).toHaveBeenCalledWith('user_1')
  })
})
