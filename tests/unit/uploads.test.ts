import { describe, it, expect } from 'vitest'
import { decodeBase64File, isXlsx, safeName, uploadKey } from '../../src/lib/uploads.js'

describe('uploaded files kept in S3 (lib/uploads)', () => {
  it('reads base64 with or without its data: prefix, and refuses junk, empty and oversize files', () => {
    const b = Buffer.from('PK\x03\x04abc', 'binary')
    expect(decodeBase64File(b.toString('base64')).equals(b)).toBe(true)
    expect(decodeBase64File(`data:application/octet-stream;base64,${b.toString('base64')}`).equals(b)).toBe(true)
    expect(() => decodeBase64File('not base64 at all!')).toThrow(/could not be read/)
    expect(() => decodeBase64File('')).toThrow(/empty/)
    expect(() => decodeBase64File(Buffer.alloc(2048).toString('base64'), 1024)).toThrow(/over/)
  })

  it('an .xlsx is a zip', () => {
    expect(isXlsx(Buffer.from('PK\x03\x04rest', 'binary'))).toBe(true)
    expect(isXlsx(Buffer.from('plate,driver\n'))).toBe(false)
    expect(isXlsx(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1]))).toBe(false) // old .xls
  })

  it('names are made safe for a key, paths and odd characters dropped', () => {
    expect(safeName('MORL_FLEET.xlsx')).toBe('MORL_FLEET.xlsx')
    expect(safeName('C:\\Users\\x\\Fleet list (Nov) #2.xlsx')).toBe('Fleet_list_Nov_2.xlsx')
    expect(safeName('../../etc/passwd')).toBe('passwd')
    expect(safeName('')).toBe('file')
  })

  it('keys start with the kind and the organisation, then the day', () => {
    const k = uploadKey('fleet-lists', 'org1', 'MORL FLEET.xlsx', new Date('2026-11-13T21:05:09Z'))
    expect(k).toMatch(/^fleet-lists\/org1\/2026\/11\/13\/210509-[0-9a-f]{12}-MORL_FLEET\.xlsx$/)
    expect(uploadKey('fleet-lists', 'org1', 'a.xlsx')).not.toBe(uploadKey('fleet-lists', 'org1', 'a.xlsx'))
  })

  it('keys sit under the bucket folder when one is set (prod: ndoo)', () => {
    const at = new Date('2026-11-14T08:00:00Z')
    expect(uploadKey('fleet-lists', 'org1', 'a.xlsx', at, 'ndoo')).toMatch(/^ndoo\/fleet-lists\/org1\/2026\/11\/14\/080000-[0-9a-f]{12}-a\.xlsx$/)
    expect(uploadKey('fleet-lists', 'org1', 'a.xlsx', at, '/ndoo/')).toMatch(/^ndoo\/fleet-lists\//)
    expect(uploadKey('fleet-lists', 'org1', 'a.xlsx', at, '')).toMatch(/^fleet-lists\//)
  })
})
