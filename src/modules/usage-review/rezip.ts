/**
 * Re-deflate a zip with Node's zlib.
 *
 * SheetJS's own deflate is weak: a two-month review's GPS sheet came out at
 * 7.9 MB where the same rows zipped by zlib are under half that. So the
 * workbook is written STORED (uncompressed) and every entry is deflated here.
 * Only what an xlsx needs: no zip64, no data descriptors, no encryption.
 */

import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
export function crc32(buf: Buffer): number {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xFF]! ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

interface Entry { name: Buffer; data: Buffer; method: number; time: number; date: number }

/** Entries of a zip, read through its central directory. Stored or deflated entries only. */
function readZip(zip: Buffer): Entry[] {
  let eocd = zip.length - 22
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--
  if (eocd < 0) throw new Error('Not a zip')
  const count = zip.readUInt16LE(eocd + 10)
  let p = zip.readUInt32LE(eocd + 16)
  const out: Entry[] = []
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('Bad central directory')
    const method = zip.readUInt16LE(p + 10)
    const time = zip.readUInt16LE(p + 12), date = zip.readUInt16LE(p + 14)
    const csize = zip.readUInt32LE(p + 20)
    const nlen = zip.readUInt16LE(p + 28), xlen = zip.readUInt16LE(p + 30), clen = zip.readUInt16LE(p + 32)
    const local = zip.readUInt32LE(p + 42)
    const name = zip.subarray(p + 46, p + 46 + nlen)
    const lstart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    out.push({ name: Buffer.from(name), data: zip.subarray(lstart, lstart + csize), method, time, date })
    p += 46 + nlen + xlen + clen
  }
  return out
}

export function rezip(zip: Buffer, level = 6): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of readZip(zip)) {
    if (e.method !== 0) throw new Error('rezip expects a stored zip')
    const raw = e.data
    const data = deflateRawSync(raw, { level })
    const crc = crc32(raw)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8)
    lh.writeUInt16LE(e.time, 10); lh.writeUInt16LE(e.date, 12); lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(e.name.length, 26); lh.writeUInt16LE(0, 28)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10)
    ch.writeUInt16LE(e.time, 12); ch.writeUInt16LE(e.date, 14); ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(e.name.length, 28)
    ch.writeUInt32LE(offset, 42)
    parts.push(lh, e.name, data)
    central.push(ch, e.name)
    offset += 30 + e.name.length + data.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  const n = central.length / 2
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(n, 8); end.writeUInt16LE(n, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cd, end])
}
