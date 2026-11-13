/**
 * Files people upload, kept in S3 (UPLOADS_S3_BUCKET), never on the box's disk.
 *
 * First user: the client's fleet list Excel (modules/fleet-list). The operator,
 * 2026-11-13: "the uploaded files need to be stored in s3 buckets". The page
 * reads the file and sends what it read; the file itself is kept too, as it
 * was uploaded, so the list on any day can be opened in Excel again.
 *
 * Credentials come from the default AWS chain: on the box, the EC2 instance
 * role. Never AWS keys in .env.example (dev loads it, and it is committed).
 * Objects are private (the bucket blocks public access); a download is a
 * presigned GET that lasts UPLOADS_PRESIGN_SECONDS.
 */
import { createHash, randomBytes } from 'node:crypto'
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from '../config/env.js'
import { BadRequestError, ServiceUnavailableError } from '../core/errors/errors.js'
import { logger } from './logger.js'

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** The most a kept file may weigh. A fleet list of 5000 units is well under 1 MB. */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

let client: S3Client | null = null
const s3 = () => (client ??= new S3Client({
  region: env.UPLOADS_S3_REGION,
  ...(env.UPLOADS_S3_ENDPOINT ? { endpoint: env.UPLOADS_S3_ENDPOINT, forcePathStyle: true } : {}),
}))

/** Whether uploads can be kept at all. */
export const uploadsEnabled = () => Boolean(env.UPLOADS_S3_BUCKET)

function bucket(): string {
  if (!env.UPLOADS_S3_BUCKET) {
    throw new ServiceUnavailableError('Uploaded files cannot be kept: file storage (UPLOADS_S3_BUCKET) is not set up on the server.')
  }
  return env.UPLOADS_S3_BUCKET
}

/** The bytes of a base64 file as the page sends it (with or without its data: prefix). */
export function decodeBase64File(data: string, max = MAX_UPLOAD_BYTES): Buffer {
  const b64 = data.replace(/^data:[^,]*,/, '')
  if (!/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(b64)) throw new BadRequestError('The file could not be read.')
  const buf = Buffer.from(b64, 'base64')
  if (!buf.length) throw new BadRequestError('The file is empty.')
  if (buf.length > max) throw new BadRequestError(`The file is over ${Math.round(max / 1024 / 1024)} MB.`)
  return buf
}

/** An .xlsx is a zip: it starts "PK\x03\x04". Anything else is refused before it is kept. */
export function isXlsx(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
}

/** A file name safe as the last part of a key: letters, digits, dot, dash, underscore. */
export function safeName(name: string): string {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? ''
  const clean = base.normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').replace(/^[._]+/, '').slice(-120)
  return clean || 'file'
}

/**
 * Where an upload lives: {kind}/{orgId}/{yyyy}/{mm}/{dd}/{time}-{random}-{name}.
 * Organisation first, so one organisation's files can be listed, exported or
 * removed by prefix; the random part keeps two uploads of one name apart.
 */
export function uploadKey(kind: string, organisationId: string, fileName: string, at = new Date()): string {
  const d = at.toISOString()
  const stamp = d.slice(11, 19).replace(/:/g, '')
  return `${kind}/${organisationId}/${d.slice(0, 4)}/${d.slice(5, 7)}/${d.slice(8, 10)}/${stamp}-${randomBytes(6).toString('hex')}-${safeName(fileName)}`
}

export type StoredFile = { key: string; size: number; type: string; sha256: string }

/** Keep a file. Throws 503 when storage is not set up, 502 when S3 refuses it. */
export async function putFile(key: string, body: Buffer, type: string, meta: Record<string, string> = {}): Promise<StoredFile> {
  const Bucket = bucket()
  const sha256 = createHash('sha256').update(body).digest('hex')
  try {
    await s3().send(new PutObjectCommand({
      Bucket, Key: key, Body: body, ContentType: type, ContentLength: body.length,
      ServerSideEncryption: 'AES256',
      ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
      Metadata: meta,
    }))
  } catch (err) {
    logger.error({ err, key }, 'uploads: S3 put failed')
    throw new ServiceUnavailableError('The file could not be stored. Try again in a minute.')
  }
  return { key, size: body.length, type, sha256 }
}

/** A link that downloads the kept file under its own name, for UPLOADS_PRESIGN_SECONDS. */
export async function fileUrl(key: string, downloadName: string): Promise<{ url: string; expiresIn: number }> {
  const Bucket = bucket()
  const ascii = safeName(downloadName)
  const disposition = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(downloadName || ascii)}`
  const expiresIn = env.UPLOADS_PRESIGN_SECONDS
  const url = await getSignedUrl(s3(), new GetObjectCommand({ Bucket, Key: key, ResponseContentDisposition: disposition }), { expiresIn })
  return { url, expiresIn }
}

/** Undo a put whose database row was never written. Best effort: a stray object is logged, not thrown. */
export async function removeFile(key: string): Promise<void> {
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }))
  } catch (err) {
    logger.warn({ err, key }, 'uploads: could not remove an orphaned object')
  }
}
