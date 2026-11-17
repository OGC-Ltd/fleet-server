/**
 * Blanks the values of credential-looking query parameters in a URL, a path
 * or a bare query string: Wialon's `token`/`sid`, signed S3 URLs, OAuth
 * `code`s. Everything else is kept as sent, so the URL stays useful.
 *
 * Used where URLs leave the process: span attributes (telemetry/sdk) and the
 * request log (middleware/request-log), both of which end up in Jaeger, Loki
 * and the S3 log archive.
 */
const SECRET_PARAM = /^(?:token|sid|access_token|refresh_token|id_token|api_?key|key|secret|client_secret|password|pass|code|sig|signature|x-amz-(?:signature|credential|security-token))$/i

export function scrubQuery(value: string): string {
  const q = value.indexOf('?')
  const isQueryOnly = q === -1 && value.includes('=') && !value.includes('/')
  if (q === -1 && !isQueryOnly) return value
  const head = isQueryOnly ? '' : value.slice(0, q + 1)
  const rest = isQueryOnly ? value : value.slice(q + 1)
  const hash = rest.indexOf('#')
  const query = hash === -1 ? rest : rest.slice(0, hash)
  const tail = hash === -1 ? '' : rest.slice(hash)
  const out = query.split('&').map((pair) => {
    const eq = pair.indexOf('=')
    if (eq === -1) return pair
    let name = pair.slice(0, eq)
    try { name = decodeURIComponent(name) } catch { /* keep it raw */ }
    return SECRET_PARAM.test(name) ? `${pair.slice(0, eq)}=[redacted]` : pair
  })
  return head + out.join('&') + tail
}
