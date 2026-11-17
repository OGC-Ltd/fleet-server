/**
 * What the logger blanks out before a line is written.
 *
 * The app logs no requests, so the way a secret reaches the log is an error
 * object. pino's err serializer copies every enumerable property, and an axios
 * error carries its whole request: `config.headers` (Authorization, API keys),
 * `config.params` (the Wialon token travels as a query parameter), `config.data`
 * (sign-in bodies), plus the raw `request`/`response`. Measured 2026-11-16: no
 * secret-looking string in the live container logs, so this is a guard for the
 * next careless `logger.error({ err })`, not a cleanup. It matters more once
 * logs leave the box (phase 4b, CloudWatch).
 *
 * fast-redact paths: a leading `*` matches one level, so `*.password` covers
 * `{ body: { password } }` but not deeper. Errors are logged under `err`
 * (188 call sites), so the axios paths are spelled out for `err` and for one
 * level of nesting (`{ result: { err } }`, `err.cause`).
 */
const AXIOS = ['config.headers', 'config.params', 'config.data', 'config.auth', 'request', 'response.config', 'response.request', 'response.headers']

const SECRET_KEYS = [
  'password', 'newPassword', 'currentPassword',
  'token', 'accessToken', 'refreshToken', 'idToken',
  'apiKey', 'api_key', 'secret', 'clientSecret',
  'authorization', 'Authorization', 'cookie', 'Cookie',
]

export const REDACT_PATHS: string[] = [
  // a request-shaped object, should anyone log one
  'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]',
  'headers.authorization', 'headers.Authorization', 'headers.cookie', 'headers["x-api-key"]',
  'res.headers["set-cookie"]',
  // axios errors, under err, under err.cause, and one level below anything
  ...AXIOS.map((p) => `err.${p}`),
  ...AXIOS.map((p) => `err.cause.${p}`),
  ...AXIOS.map((p) => `*.${p}`),
  // secret-named fields at the top level and one level down
  ...SECRET_KEYS,
  ...SECRET_KEYS.map((k) => `*.${k}`),
]

export const REDACT = { paths: REDACT_PATHS, censor: '[redacted]' } as const
