/**
 * VSS, Control Tech's dashcam platform (VSS Web API v2.8.0), server-side.
 *
 * The account, password and session token live here and nowhere else. The
 * dashboard plays video with VSS's custom-UI player SDK (new-ui
 * public/vss-sdk), which talks to VSS's media server directly and needs only
 * the device number and channel. VSS's own player PAGE was the other route,
 * and it cannot be used: it wants the token in its URL and sends
 * `X-Frame-Options: SAMEORIGIN`, so it will not open inside the dashboard.
 *
 * A token dies after 30 minutes with no API call (API §3.1); a "not logged
 * in" or "token error" answer logs in again once and retries.
 *
 * ## TLS
 *
 * vss.controltech-ea.com serves a valid Sectigo wildcard certificate without
 * its intermediate. Chrome fetches the missing link itself (AIA); Node does
 * not, and fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE. The public intermediate
 * is supplied below as an extra CA for these requests only — verification
 * stays on, and the chain still has to end at a root Node already trusts.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import http from 'node:http'
import tls from 'node:tls'
import { env } from '../../config/env.js'

/** "Sectigo Public Server Authentication CA DV R36", from the leaf's AIA URL; expires 2036-03-21. */
const SECTIGO_DV_R36 = `-----BEGIN CERTIFICATE-----
MIIGTDCCBDSgAwIBAgIQOXpmzCdWNi4NqofKbqvjsTANBgkqhkiG9w0BAQwFADBf
MQswCQYDVQQGEwJHQjEYMBYGA1UEChMPU2VjdGlnbyBMaW1pdGVkMTYwNAYDVQQD
Ey1TZWN0aWdvIFB1YmxpYyBTZXJ2ZXIgQXV0aGVudGljYXRpb24gUm9vdCBSNDYw
HhcNMjEwMzIyMDAwMDAwWhcNMzYwMzIxMjM1OTU5WjBgMQswCQYDVQQGEwJHQjEY
MBYGA1UEChMPU2VjdGlnbyBMaW1pdGVkMTcwNQYDVQQDEy5TZWN0aWdvIFB1Ymxp
YyBTZXJ2ZXIgQXV0aGVudGljYXRpb24gQ0EgRFYgUjM2MIIBojANBgkqhkiG9w0B
AQEFAAOCAY8AMIIBigKCAYEAljZf2HIz7+SPUPQCQObZYcrxLTHYdf1ZtMRe7Yeq
RPSwygz16qJ9cAWtWNTcuICc++p8Dct7zNGxCpqmEtqifO7NvuB5dEVexXn9RFFH
12Hm+NtPRQgXIFjx6MSJcNWuVO3XGE57L1mHlcQYj+g4hny90aFh2SCZCDEVkAja
EMMfYPKuCjHuuF+bzHFb/9gV8P9+ekcHENF2nR1efGWSKwnfG5RawlkaQDpRtZTm
M64TIsv/r7cyFO4nSjs1jLdXYdz5q3a4L0NoabZfbdxVb+CUEHfB0bpulZQtH1Rv
38e/lIdP7OTTIlZh6OYL6NhxP8So0/sht/4J9mqIGxRFc0/pC8suja+wcIUna0HB
pXKfXTKpzgis+zmXDL06ASJf5E4A2/m+Hp6b84sfPAwQ766rI65mh50S0Di9E3Pn
2WcaJc+PILsBmYpgtmgWTR9eV9otfKRUBfzHUHcVgarub/XluEpRlTtZudU5xbFN
xx/DgMrXLUAPaI60fZ6wA+PTAgMBAAGjggGBMIIBfTAfBgNVHSMEGDAWgBRWc1hk
lfmSGrASKgRieaFAFYghSTAdBgNVHQ4EFgQUaMASFhgOr872h6YyV6NGUV3LBycw
DgYDVR0PAQH/BAQDAgGGMBIGA1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0lBBYwFAYI
KwYBBQUHAwEGCCsGAQUFBwMCMBsGA1UdIAQUMBIwBgYEVR0gADAIBgZngQwBAgEw
VAYDVR0fBE0wSzBJoEegRYZDaHR0cDovL2NybC5zZWN0aWdvLmNvbS9TZWN0aWdv
UHVibGljU2VydmVyQXV0aGVudGljYXRpb25Sb290UjQ2LmNybDCBhAYIKwYBBQUH
AQEEeDB2ME8GCCsGAQUFBzAChkNodHRwOi8vY3J0LnNlY3RpZ28uY29tL1NlY3Rp
Z29QdWJsaWNTZXJ2ZXJBdXRoZW50aWNhdGlvblJvb3RSNDYucDdjMCMGCCsGAQUF
BzABhhdodHRwOi8vb2NzcC5zZWN0aWdvLmNvbTANBgkqhkiG9w0BAQwFAAOCAgEA
YtOC9Fy+TqECFw40IospI92kLGgoSZGPOSQXMBqmsGWZUQ7rux7cj1du6d9rD6C8
ze1B2eQjkrGkIL/OF1s7vSmgYVafsRoZd/IHUrkoQvX8FZwUsmPu7amgBfaY3g+d
q1x0jNGKb6I6Bzdl6LgMD9qxp+3i7GQOnd9J8LFSietY6Z4jUBzVoOoz8iAU84OF
h2HhAuiPw1ai0VnY38RTI+8kepGWVfGxfBWzwH9uIjeooIeaosVFvE8cmYUB4TSH
5dUyD0jHct2+8ceKEtIoFU/FfHq/mDaVnvcDCZXtIgitdMFQdMZaVehmObyhRdDD
4NQCs0gaI9AAgFj4L9QtkARzhQLNyRf87Kln+YU0lgCGr9HLg3rGO8q+Y4ppLsOd
unQZ6ZxPNGIfOApbPVf5hCe58EZwiWdHIMn9lPP6+F404y8NNugbQixBber+x536
WrZhFZLjEkhp7fFXf9r32rNPfb74X/U90Bdy4lzp3+X1ukh1BuMxA/EEhDoTOS3l
7ABvc7BYSQubQ2490OcdkIzUh3ZwDrakMVrbaTxUM2p24N6dB+ns2zptWCva6jzW
r8IWKIMxzxLPv5Kt3ePKcUdvkBU/smqujSczTzzSjIoR5QqQA6lN1ZRSnuHIWCvh
JEltkYnTAH41QJ6SAWO66GrrUESwN/cgZzL4JLEqz1Y=
-----END CERTIFICATE-----`

const CA = [...tls.rootCertificates, SECTIGO_DV_R36]
const TIMEOUT_MS = 10_000
/** The device register changes when Control Tech fits or renames a unit. */
const DEVICE_TTL_MS = 10 * 60_000

/** API §8.1. */
const OK = 10000
const NOT_LOGGED_IN = 10004
const TOKEN_ERROR = 10023

/** VSS's answer when it is rate-limiting this account's logins. */
export const VSS_LOGIN_LIMITED = 10082
/** "Requests too frequent" (§8.1) — met on the evidence search, 2026-10-23. */
export const VSS_TOO_FREQUENT = 10129

// ── Pacing ─────────────────────────────────────────────────────────────────
//
// VSS limits how often one account may call it, and how often it may run its
// heavy searches (seen live: a second §3.24 page 2 s after the first answered
// 10129). Every request therefore goes through one queue with a minimum gap,
// and after a 10129 nothing is sent for BUSY_BACKOFF_MS — asking again only
// extends the refusal. One process holds this state; a second instance of the
// server would pace on its own.
const MIN_GAP_MS = 2_000
const BUSY_BACKOFF_MS = 90_000
let lastSentAt = 0
let queue: Promise<unknown> = Promise.resolve()
let busyUntil = 0

/** Run `fn` after every earlier VSS request, at least MIN_GAP_MS after the last. */
function paced<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = lastSentAt + MIN_GAP_MS - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastSentAt = Date.now()
    return fn()
  })
  queue = run.catch(() => undefined)
  return run
}

/** True while VSS has asked us to slow down. */
export function vssBusy(): boolean {
  return Date.now() < busyUntil
}

export class VssError extends Error {
  constructor(message: string, readonly status: number | null = null) { super(message) }
}

export interface VssChannel {
  /** 1-based, as the player's `chs` parameter wants it. */
  no:   number
  name: string
}

export interface VssDevice {
  /** The device number VSS keys everything by (an IMEI on this fleet). */
  deviceId: string
  name:     string
  plate:    string
  channels: VssChannel[]
  /** API §8.5 access mode: ≥1 online (by link type), -1 offline, 0 unknown. */
  accessMode: number
}

export function vssAvailable(): boolean {
  return env.VSS_BASE_URL.length > 0 && env.VSS_USERNAME.length > 0 && env.VSS_PASSWORD.length > 0
}

function base(): URL {
  return new URL(env.VSS_BASE_URL.endsWith('/') ? env.VSS_BASE_URL : env.VSS_BASE_URL + '/')
}

interface Envelope<T> { status: number; msg?: string; data: T }

function post<T>(path: string, body: Record<string, unknown>): Promise<Envelope<T>> {
  return paced(() => postNow<T>(path, body))
}

function postNow<T>(path: string, body: Record<string, unknown>): Promise<Envelope<T>> {
  const url = new URL(path.replace(/^\//, ''), base())
  const payload = JSON.stringify(body)
  const lib = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: TIMEOUT_MS,
      ...(url.protocol === 'https:' ? { ca: CA } : {}),
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        try { resolve(JSON.parse(text) as Envelope<T>) } catch {
          reject(new VssError(`VSS returned HTTP ${res.statusCode} without JSON`))
        }
      })
    })
    req.on('timeout', () => req.destroy(new VssError('VSS did not answer in time')))
    req.on('error', (err) => reject(err instanceof VssError ? err : new VssError(`VSS unreachable: ${err.message}`)))
    req.end(payload)
  })
}

/**
 * VSS rate-limits logins per account and answers 10082 "Login too frequently"
 * (met 2026-10-22, after a handful of logins within minutes). Every refused
 * attempt seemed to extend the lockout, so after one the server stops asking
 * for LOGIN_BACKOFF_MS, and the session token is kept on disk so a restart or
 * a deploy reuses it instead of logging in again.
 */
const LOGIN_TOO_FREQUENT = VSS_LOGIN_LIMITED
const LOGIN_BACKOFF_MS = 5 * 60_000
const SESSION_FILE = path.join(os.tmpdir(), 'fleet-server-vss-session.json')

let session: { token: string } | null = readSession()
let loggingIn: Promise<string> | null = null
let loginBlockedUntil = 0

function readSession(): { token: string } | null {
  try {
    const saved = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) as { base?: string; user?: string; token?: string }
    // Only a token for THIS server and account: the file outlives config changes.
    return saved.token && saved.base === env.VSS_BASE_URL && saved.user === env.VSS_USERNAME ? { token: saved.token } : null
  } catch { return null }
}

function saveSession(token: string | null): void {
  try {
    if (token) fs.writeFileSync(SESSION_FILE, JSON.stringify({ base: env.VSS_BASE_URL, user: env.VSS_USERNAME, token }), { mode: 0o600 })
    else fs.rmSync(SESSION_FILE, { force: true })
  } catch { /* the in-memory session still works */ }
}

async function login(): Promise<string> {
  if (Date.now() < loginBlockedUntil) {
    throw new VssError('VSS is refusing sign-ins for a few minutes (too many recent logins)', LOGIN_TOO_FREQUENT)
  }
  const password = crypto.createHash('md5').update(env.VSS_PASSWORD).digest('hex')
  const res = await post<{ token: string }>('/vss/user/apiLogin.action', { username: env.VSS_USERNAME, password })
  if (res.status !== OK || !res.data?.token) {
    if (res.status === LOGIN_TOO_FREQUENT) loginBlockedUntil = Date.now() + LOGIN_BACKOFF_MS
    throw new VssError(`VSS login refused: ${res.msg ?? res.status}`, res.status)
  }
  session = { token: res.data.token }
  saveSession(res.data.token)
  return res.data.token
}

/** One login at a time: a burst of camera opens shares the same new token. */
function freshToken(): Promise<string> {
  loggingIn ??= login().finally(() => { loggingIn = null })
  return loggingIn
}

/** Calls `path` with the session token, logging in again once if VSS has dropped it. */
async function call<T>(path: string, body: Record<string, unknown>): Promise<{ data: T; token: string }> {
  if (vssBusy()) throw new VssError('VSS asked us to slow down; waiting before asking again', VSS_TOO_FREQUENT)
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = session?.token ?? await freshToken()
    const res = await post<T>(path, { ...body, token })
    if (res.status === OK) return { data: res.data, token }
    if ((res.status === NOT_LOGGED_IN || res.status === TOKEN_ERROR) && attempt === 0) {
      session = null
      saveSession(null)
      continue
    }
    if (res.status === VSS_TOO_FREQUENT || /too\s*frequent/i.test(res.msg ?? '')) {
      busyUntil = Date.now() + BUSY_BACKOFF_MS
      throw new VssError(`VSS ${path}: ${res.msg ?? res.status}`, VSS_TOO_FREQUENT)
    }
    throw new VssError(`VSS ${path}: ${res.msg ?? res.status}`, res.status)
  }
  throw new VssError(`VSS ${path}: session could not be renewed`)
}

/** `ch1;ch2` → channels 1 and 2, keeping the installer's names where they gave one. */
export function parseChannels(channelName: string | null | undefined, count: number | null | undefined): VssChannel[] {
  const names = (channelName ?? '').split(';').map(s => s.trim())
  const n = Number.isInteger(count) && (count as number) > 0 ? (count as number) : names.filter(Boolean).length
  return Array.from({ length: n }, (_, i) => ({ no: i + 1, name: names[i] || `Channel ${i + 1}` }))
}

interface RawDevice {
  deviceno: string | number
  devicename?: string | null
  plateno?: string | null
  channelname?: string | null
  videoencodernumber?: number | null
  accessmode?: number | null
}

let devices: { at: number; list: VssDevice[] } | null = null

/** Every device this account sees, cached for DEVICE_TTL_MS. */
export async function listDevices(): Promise<VssDevice[]> {
  if (devices && Date.now() - devices.at < DEVICE_TTL_MS) return devices.list
  const { data } = await call<{ dataList?: RawDevice[] }>('/vss/vehicle/findAll.action', { pageNum: -1, pageCount: -1 })
  const list = (data?.dataList ?? []).map((d): VssDevice => ({
    deviceId:   String(d.deviceno),
    name:       (d.devicename ?? '').trim(),
    plate:      (d.plateno ?? '').trim(),
    channels:   parseChannels(d.channelname, d.videoencodernumber),
    accessMode: Number(d.accessmode ?? 0),
  }))
  devices = { at: Date.now(), list }
  return list
}

/** The device's online state now (API §3.4, §8.5). */
export async function liveStatus(deviceId: string): Promise<number> {
  const { data } = await call<{ accessMode?: number } | { accessMode?: number }[]>(
    '/vss/onoffline/queryDeviceStatus.action', { deviceID: deviceId },
  )
  const row = Array.isArray(data) ? data[0] : data
  return Number(row?.accessMode ?? 0)
}

/**
 * The media server the dashboard's player connects to: the custom-UI SDK
 * (API §6.2) opens `wss://<vss host>:36301/stream`, and `ipaddr=127.0.0.1`
 * is what it sends when the media server is the VSS host itself.
 */
export function streamUrl(): string {
  return `wss://${base().hostname}:${env.VSS_STREAM_PORT}/stream?ipaddr=127.0.0.1`
}

/**
 * Any VSS API call, signed in, paced and backed off like the rest (see above).
 * For the dashcam alarms module (modules/dashcam).
 */
export async function vssCall<T>(path: string, body: Record<string, unknown>): Promise<T> {
  return (await call<T>(path, body)).data
}

/** Is this URL on the VSS host (any port)? Nothing else may be fetched through here. */
export function isVssFileUrl(u: string): boolean {
  try {
    const url = new URL(u)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname.toLowerCase() === base().hostname.toLowerCase()
  } catch { return false }
}

/**
 * GET an evidence file (clip or snapshot) from VSS's file server, passing a
 * browser's Range through. Resolves with the live response for the caller to
 * pipe; the caller checks the status.
 */
export function fetchVssFile(u: string, range?: string): Promise<http.IncomingMessage> {
  if (!isVssFileUrl(u)) return Promise.reject(new VssError('Not a VSS file'))
  const url = new URL(u)
  const lib = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method: 'GET',
      headers: { Accept: '*/*', 'Accept-Encoding': 'identity', ...(range ? { Range: range } : {}) },
      timeout: 30_000,
      ...(url.protocol === 'https:' ? { ca: CA } : {}),
    }, resolve)
    req.on('timeout', () => req.destroy(new VssError('VSS file server did not answer in time')))
    req.on('error', (err) => reject(err instanceof VssError ? err : new VssError(`VSS file server unreachable: ${err.message}`)))
    req.end()
  })
}
