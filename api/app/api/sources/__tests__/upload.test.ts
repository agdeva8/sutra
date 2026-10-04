/**
 * Sources upload endpoint — integration tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockGuestToken: vi.fn(),
  mockUploadFile: vi.fn(),
  mockExtractText: vi.fn(),
  mockAfter: vi.fn(),
  mockDbInsertReturning: vi.fn(),
}))

vi.mock('@/lib/env', () => ({
  env: {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    AUTH_SECRET: 'test-secret-test-secret-test-secret-test-secret-32+chars',
    EMERGENT_LLM_KEY: 'sk-emergent-test',
    INTEGRATION_PROXY_URL: 'https://integrations.emergentagent.com',
  },
}))

vi.mock('@/lib/auth', () => ({ auth: mocks.mockAuth }))
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return { ...actual, after: mocks.mockAfter }
})
vi.mock('@/lib/guest-token', () => ({ verifyGuestToken: mocks.mockGuestToken }))
vi.mock('@/lib/storage', () => ({
  uploadFile: mocks.mockUploadFile,
  deleteFile: vi.fn(),
  getSignedDownloadUrl: vi.fn(),
  sanitizeFilename: vi.fn((s: string) => s),
}))
vi.mock('@/lib/sources', () => ({
  extractText: mocks.mockExtractText,
  fetchLinkText: vi.fn(),
}))
vi.mock('@/lib/db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((vals: any) => ({
        returning: vi.fn(() => Promise.resolve([{
          id: 'src_mock001',
          userId: vals?.userId ?? null,
          goalId: vals?.goalId ?? null,
          goalTitle: vals?.goalTitle ?? '',
          kind: vals?.kind ?? 'file',
          storagePath: vals?.storagePath ?? '',
          originalFilename: vals?.originalFilename ?? '',
          contentType: vals?.contentType ?? '',
          size: vals?.size ?? 0,
          url: vals?.url ?? '',
          textExcerpt: vals?.textExcerpt ?? '',
          isDeleted: vals?.isDeleted ?? false,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        }])),
      })),
    })),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
        orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    }),
  },
}))

import { POST } from '../upload/route'
import { NextRequest } from 'next/server'

const { mockAuth, mockGuestToken, mockUploadFile, mockExtractText, mockAfter, mockDbInsertReturning } = mocks

const SESSION_TOKEN = 'user_founder01'

function makeUploadRequest(formData: FormData, token?: string) {
  const headers = new Headers()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return new NextRequest('http://localhost/api/sources/upload', {
    method: 'POST',
    headers,
    body: formData,
  })
}

function makeFile(name: string, content: string, type: string) {
  return new File([new Blob([content], { type })], name, { type })
}

describe('POST /api/sources/upload', () => {
  beforeEach(() => {
    mockAfter.mockImplementation(() => undefined)
    mockAuth.mockResolvedValue({
      user: { id: 'user_founder01', isGuest: false, modelProvider: 'gemini' },
    })
    mockGuestToken.mockReturnValue(null)
    mockUploadFile.mockResolvedValue({
      pathname: 'goalcoach/uploads/user_founder01/test.pdf',
      url: 'https://integrations.emergentagent.com/objstore/api/v1/storage/objects/goalcoach/uploads/user_founder01/test.pdf',
    })
    mockExtractText.mockResolvedValue('[mock excerpt]')
    mockDbInsertReturning.mockResolvedValue([{
      id: 'src_mock001',
      userId: 'user_founder01',
      goalId: null,
      goalTitle: '',
      kind: 'file',
      storagePath: 'goalcoach/uploads/user_founder01/test.pdf',
      originalFilename: 'test.pdf',
      contentType: 'application/pdf',
      size: 1024,
      url: '',
      textExcerpt: '[mock excerpt]',
      isDeleted: false,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    }])
  })
  afterEach(() => { vi.clearAllMocks() })

  it('rejects unauthenticated requests with 401', async () => {
    mockAuth.mockResolvedValueOnce({ user: null })
    const form = new FormData()
    form.set('file', makeFile('test.pdf', '%PDF-1.4', 'application/pdf'))
    const res = await POST(makeUploadRequest(form))
    expect(res.status).toBe(401)
  })

  it('returns 400 when no file is provided', async () => {
    const form = new FormData()
    const res = await POST(makeUploadRequest(form, SESSION_TOKEN))
    expect(res.status).toBe(400)
    expect((await res.json()).detail).toMatch(/no file/i)
  })

  it('returns 413 when file exceeds 20MB', async () => {
    const huge = new Uint8Array(21 * 1024 * 1024)
    const form = new FormData()
    form.set('file', new File([huge], 'large.pdf', { type: 'application/pdf' }))
    const res = await POST(makeUploadRequest(form, SESSION_TOKEN))
    expect(res.status).toBe(413)
  })

  it('returns 400 for unsupported file types', async () => {
    for (const [name, type] of [
      ['evil.exe', 'application/x-executable'],
      ['bad.sh', 'application/x-sh'],
    ]) {
      const form = new FormData()
      form.set('file', makeFile(name, 'echo hack', type))
      const res = await POST(makeUploadRequest(form, SESSION_TOKEN))
      expect(res.status).toBe(400)
      expect((await res.json()).detail).toMatch(/unsupported/i)
    }
  })

  it('accepts pdf and returns source record with correct shape', async () => {
    const form = new FormData()
    form.set('file', makeFile('report.pdf', '%PDF-1.4', 'application/pdf'))
    const res = await POST(makeUploadRequest(form, SESSION_TOKEN))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.kind).toBe('file')
    expect(data.original_filename).toBe('report.pdf')
    expect(data.id).toMatch(/^src_/)
    expect(mockUploadFile).toHaveBeenCalled()
    expect(mockExtractText).toHaveBeenCalledWith('report.pdf', expect.any(Buffer))
  })

  it('accepts md, txt, csv, json files', async () => {
    for (const [name, type] of [
      ['notes.md', 'text/markdown'],
      ['readme.txt', 'text/plain'],
      ['data.csv', 'text/csv'],
      ['data.json', 'application/json'],
    ]) {
      const form = new FormData()
      form.set('file', makeFile(name, '[]', type))
      const res = await POST(makeUploadRequest(form, SESSION_TOKEN))
      expect(res.status).toBe(200)
    }
  })

  it('accepts image types offered by the UI (webp/gif/heic/heif/bmp/tiff)', async () => {
    // Regression: the Memories picker advertises image/webp and the camera
    // input is `image/*` (HEIC on iOS), but the server allow-list previously
    // rejected everything except png/jpg/jpeg.
    for (const [name, type] of [
      ['photo.webp', 'image/webp'],
      ['anim.gif', 'image/gif'],
      ['capture.heic', 'image/heic'],
      ['capture.heif', 'image/heif'],
      ['scan.bmp', 'image/bmp'],
      ['scan.tiff', 'image/tiff'],
    ]) {
      const form = new FormData()
      form.set('file', makeFile(name, 'binary', type))
      const res = await POST(makeUploadRequest(form, SESSION_TOKEN))
      expect(res.status, `${name} should be accepted`).toBe(200)
    }
  })

  it('returns an image source before OCR and schedules extraction after the response', async () => {
    const form = new FormData()
    form.set('file', makeFile('profile.jpg', 'binary', 'image/jpeg'))

    const res = await POST(makeUploadRequest(form, SESSION_TOKEN))

    expect(res.status).toBe(200)
    expect((await res.json()).text_pending).toBe(true)
    expect(mockExtractText).not.toHaveBeenCalled()
    expect(mockAfter).toHaveBeenCalledTimes(1)
  })

  it('calls Emergent Object Storage upload with user-scoped path', async () => {
    const form = new FormData()
    form.set('file', makeFile('report.pdf', '%PDF-1.4', 'application/pdf'))
    await POST(makeUploadRequest(form, SESSION_TOKEN))
    expect(mockUploadFile).toHaveBeenCalledWith(
      'user_founder01',
      'report.pdf',
      expect.any(Buffer),
      'application/pdf',
    )
  })

  it('rejects goal_id that does not belong to the caller', async () => {
    // Goal ownership (P1 security): the caller must not be able to
    // attach their upload to another user's goal by guessing its id.
    // The mock for db.select(...).from(goals) returns [], so the
    // goal lookup fails and the route returns 404.
    const form = new FormData()
    form.set('file', makeFile('doc.txt', 'hello', 'text/plain'))
    form.set('goal_id', 'goal_not_mine')
    const res = await POST(makeUploadRequest(form, SESSION_TOKEN))
    expect(res.status).toBe(404)
    expect((await res.json()).detail).toMatch(/goal not found/i)
  })
})
