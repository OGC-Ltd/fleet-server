/**
 * The dashboard's Alarms tab (dashcam alarms from Control Tech's VSS).
 *
 *   GET /api/v1/vss/cameras?org=<orgId>
 *   GET /api/v1/vss/alarms?org=<orgId>&since=<ISO>
 *   GET /api/v1/vss/file?org=<orgId>&k=<key>[&download=1]
 *
 * Mounted at /api/v1/vss with the organisation in the QUERY, because that is
 * the dashboard's contract (and vss.php's, on cPanel). `orgFromQuery` puts it
 * where the standard middleware looks — req.params.orgId — so access is
 * decided exactly as on every /organisations/:orgId route: signed in, may
 * reach the org, holds vehicle:read, and sees only the vehicles in scope.
 */

import { Router, type RequestHandler } from 'express'
import { authenticate, requireOrgAccess } from '../../middleware/auth.js'
import { requirePermission } from '../../middleware/authorize.js'
import { sendSuccess, sendError } from '../../core/response/response.js'
import { BadRequestError } from '../../core/errors/errors.js'
import { logger } from '../../lib/logger.js'
import { fetchVssFile, VssError, VSS_TOO_FREQUENT, VSS_LOGIN_LIMITED } from '../../providers/vss/index.js'
import { cameraCount, getAlarms, fileFor } from './dashcam.service.js'

const orgFromQuery: RequestHandler = (req, _res, next) => {
  const org = typeof req.query['org'] === 'string' ? req.query['org'] : ''
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(org)) return next(new BadRequestError('org is required'))
  ;(req.params as Record<string, string>)['orgId'] = org
  next()
}

const noStore: RequestHandler = (_req, res, next) => { res.set('Cache-Control', 'no-store'); next() }

const guard = [orgFromQuery, authenticate, requireOrgAccess, requirePermission('vehicle:read')]

/** What to tell the dashboard when VSS itself is the problem. */
function vssProblem(err: unknown): string | null {
  if (!(err instanceof VssError)) return null
  if (err.status === VSS_TOO_FREQUENT) return 'The video server asked us to slow down. Alarms will refresh in a minute or two.'
  if (err.status === VSS_LOGIN_LIMITED) return 'The video server is limiting sign-ins. Try again in about five minutes.'
  return 'The camera service is not answering. Try again in a minute.'
}

const router = Router()

router.get('/cameras', ...guard, noStore, async (req, res, next) => {
  try {
    const cameras = await cameraCount(req.params['orgId'] as string, req.authz?.vehicleIds ?? null)
    sendSuccess(res, { cameras })
  } catch (err) {
    // The count only decides whether the tab shows: VSS being down is "0".
    if (err instanceof VssError) { logger.warn({ err }, 'dashcam: camera count failed'); return sendSuccess(res, { cameras: 0 }) }
    next(err)
  }
})

router.get('/alarms', ...guard, noStore, async (req, res, next) => {
  try {
    const since = typeof req.query['since'] === 'string' ? req.query['since'] : undefined
    sendSuccess(res, await getAlarms(req.params['orgId'] as string, req.authz?.vehicleIds ?? null, since))
  } catch (err) {
    const msg = vssProblem(err)
    if (msg) return sendError(res, 502, msg)
    next(err)
  }
})

/**
 * One clip or snapshot, streamed from VSS's file server with the browser's
 * Range passed through (so a video can seek). Two quirks of that server:
 * it labels everything application/octet-stream (the real type is read from
 * the first bytes), and it answers 416 to a range running past the end of a
 * small file (asked again without the range).
 */
router.get('/file', ...guard, async (req, res, next) => {
  const k = typeof req.query['k'] === 'string' ? req.query['k'] : ''
  const url = /^[a-f0-9]{40}$/.test(k) ? fileFor(req.params['orgId'] as string, k) : null
  if (!url) return sendError(res, 404, 'This clip link has expired. Reload the alarms.')
  const range = typeof req.headers.range === 'string' && /^bytes=\d*-\d*(,\d*-\d*)*$/.test(req.headers.range) ? req.headers.range : undefined
  try {
    let up = await fetchVssFile(url, range)
    if (up.statusCode === 416 && range) { up.resume(); up = await fetchVssFile(url) }
    const status = up.statusCode ?? 502
    if (status === 404 || status === 416) { up.resume(); return sendError(res, 404, 'VSS has no file for this alarm (not uploaded yet, or deleted)') }
    if (status >= 400) { up.resume(); return sendError(res, 502, `VSS file server answered ${status}`) }

    let headed = false
    const head = (first: Buffer | null) => {
      if (headed) return
      headed = true
      let type = String(up.headers['content-type'] ?? '')
      if (!type || /octet-stream|^text\//i.test(type)) {
        type = first && first[0] === 0xff && first[1] === 0xd8 ? 'image/jpeg'
          : first && first.subarray(0, 4).toString('latin1') === '\x89PNG' ? 'image/png' : 'video/mp4'
      }
      res.status(status)
      res.setHeader('Content-Type', type)
      for (const h of ['content-length', 'content-range', 'last-modified', 'etag']) {
        const v = up.headers[h]
        if (v !== undefined) res.setHeader(h, v as string)
      }
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('Cache-Control', 'private, max-age=600')
      if (req.query['download'] !== undefined) {
        res.setHeader('Content-Disposition', `attachment; filename="dashcam-${k.slice(0, 10)}${type.startsWith('image/') ? '.jpg' : '.mp4'}"`)
      }
    }
    up.once('data', (chunk: Buffer) => { head(chunk); res.write(chunk); up.pipe(res) })
    up.once('end', () => { if (!headed) { head(null); res.end() } })
    up.on('error', (err) => { logger.warn({ err }, 'dashcam: file stream broke'); res.destroy(err) })
    req.on('close', () => up.destroy())
  } catch (err) {
    if (err instanceof VssError) return sendError(res, 502, err.message)
    next(err)
  }
})

export default router
