import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import { UnauthorizedError } from '../../core/errors/errors.js'
import { setAuthCookies, clearAuthCookies } from '../auth/auth.cookies.js'
import * as service from './account.service.js'
import type {
  UpdateProfileDto, ChangePasswordDto, ForgotPasswordDto, SetupDto,
} from './account.schema.js'

/** The device a request came from, for the session row and the security mail. */
const contextOf = (req: Parameters<RequestHandler>[0]) => ({
  userAgent: req.get('user-agent') ?? null,
  ip: req.ip ?? null,
})

/** The caller, or a 401. Never a `:userId` — see account.service.ts. */
function selfId(req: Parameters<RequestHandler>[0]): string {
  const id = req.user?.id
  if (!id) throw new UnauthorizedError('Not authenticated')
  return id
}

export const updateProfile: RequestHandler = async (req, res, next) => {
  try {
    const dto = req.body as UpdateProfileDto
    const user = await service.changeOwnName(selfId(req), dto.fullName)
    // The updated user goes back in the body so the client can refresh its own
    // copy: /auth/me is served from a per-process cache that another pm2
    // worker may still hold stale.
    sendSuccess(res, { user }, 200)
  } catch (err) {
    next(err)
  }
}

export const changePassword: RequestHandler = async (req, res, next) => {
  try {
    const dto = req.body as ChangePasswordDto
    const session = await service.changeOwnPassword(selfId(req), dto, contextOf(req))

    // Every previous session was revoked, including this one. The replacement
    // is handed back both ways — cookie for the browser and SSE, body for the
    // in-memory access token the dashboard holds.
    setAuthCookies(res, session.accessToken, session.refreshToken)
    sendSuccess(res, { accessToken: session.accessToken, expiresIn: session.expiresIn }, 200)
  } catch (err) {
    next(err)
  }
}

export const forgotPassword: RequestHandler = async (req, res, next) => {
  try {
    const dto = req.body as ForgotPasswordDto
    await service.requestPasswordReset(dto.email, contextOf(req))
    // Deliberately identical for every outcome — known, unknown, suspended,
    // deleted, no email, rate-limited. The mail is the only signal.
    sendSuccess(res, { requested: true }, 200)
  } catch (err) {
    next(err)
  }
}

export const describeSetup: RequestHandler = async (req, res, next) => {
  try {
    const info = await service.describeSetupToken(String(req.params['token'] ?? ''))
    // A 32-byte random token cannot be enumerated, so 404 is safe here and is
    // what lets the screen show "this link has expired" rather than a blank form.
    if (!info) {
      sendSuccess(res, { valid: false }, 200)
      return
    }
    sendSuccess(res, { valid: true, ...info }, 200)
  } catch (err) {
    next(err)
  }
}

export const completeSetup: RequestHandler = async (req, res, next) => {
  try {
    const dto = req.body as SetupDto
    const result = await service.completeSetup(dto.token, dto.password, contextOf(req))
    setAuthCookies(res, result.accessToken, result.refreshToken)
    // Signed in on the spot: making somebody who just proved ownership of the
    // mailbox type the password again immediately buys nothing.
    sendSuccess(res, {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: result.user,
    }, 200)
  } catch (err) {
    next(err)
  }
}

/** Everything the account page needs about the person, in one call. */
export const getProfile: RequestHandler = async (req, res, next) => {
  try {
    const [user, access] = await Promise.all([
      service.getOwnProfile(selfId(req)),
      service.listOwnAccess(selfId(req)),
    ])
    sendSuccess(res, { user, ...access }, 200)
  } catch (err) {
    next(err)
  }
}

export const listSessions: RequestHandler = async (req, res, next) => {
  try {
    // `sid` is the session this access token was minted for, so the list can
    // mark one row "this device" — and the UI can warn before revoking it.
    const sessions = await service.listOwnSessions(selfId(req), req.authSessionId ?? null)
    sendSuccess(res, { sessions }, 200)
  } catch (err) {
    next(err)
  }
}

export const revokeSession: RequestHandler = async (req, res, next) => {
  try {
    await service.revokeOwnSession(selfId(req), String(req.params['sessionId'] ?? ''))
    sendSuccess(res, { revoked: true }, 200)
  } catch (err) {
    next(err)
  }
}

/**
 * Sign out everywhere, including here.
 *
 * Unlike a password change this does NOT mint a replacement session: the point
 * of the button is to end every session, and quietly keeping the current one
 * alive would make it a lie.
 */
export const revokeAllSessions: RequestHandler = async (req, res, next) => {
  try {
    const count = await service.revokeEverySession(selfId(req))
    clearAuthCookies(res)
    sendSuccess(res, { revoked: count }, 200)
  } catch (err) {
    next(err)
  }
}
