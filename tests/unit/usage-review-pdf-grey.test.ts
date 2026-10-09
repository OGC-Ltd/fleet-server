import { describe, it, expect, vi } from 'vitest'
import zlib from 'node:zlib'
vi.mock('../../src/lib/prisma.js', () => ({ prisma: {} }))
import { greyPng } from '../../src/modules/usage-review/usage-review.pdf.js'

const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body))
  return Buffer.concat([len, body, crc])
}
const png = (colourType: number, palette: number[]) => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = colourType
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(palette.length ? [chunk('PLTE', Buffer.from(palette))] : []),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

describe('greyPng', () => {
  it('turns a paletted tile grey, with a valid checksum', () => {
    const out = greyPng(png(3, [0, 128, 0, 30, 60, 200]))
    const at = out.indexOf('PLTE', 0, 'latin1')
    const pal = [...out.subarray(at + 4, at + 10)]
    expect(pal).toEqual([75, 75, 75, 67, 67, 67])
    expect(out.readUInt32BE(at + 10)).toBe(zlib.crc32(out.subarray(at, at + 10)))
  })
  it('leaves any other image as it was', () => {
    const rgb = png(2, [])
    expect(greyPng(rgb)).toBe(rgb)
    const junk = Buffer.from('not a png at all, just some bytes here')
    expect(greyPng(junk)).toBe(junk)
  })
})
