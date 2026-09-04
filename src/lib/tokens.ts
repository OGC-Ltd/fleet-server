/**
 * What a bearer-ish token is, in one place.
 *
 * Refresh tokens and emailed password links are the same kind of object: a
 * long random string handed to someone else, stored only as a hash so a
 * database read cannot recover it, and looked up by that hash. They were
 * defined privately inside auth.service.ts first; the password-token service
 * needs exactly the same primitives, and two definitions of "how we hash a
 * secret" is one more than a codebase should have.
 *
 * base64url rather than hex: it survives a cookie round trip and a URL
 * fragment without escaping, and it is shorter for the same entropy.
 */

import crypto from 'node:crypto'

/** 32 bytes of entropy — the same budget as a refresh token. */
export function mintToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

/** The value that goes in the database. Never store the raw token. */
export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}
