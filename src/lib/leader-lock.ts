/**
 * One writer, however the server was started.
 *
 * The poller and the background jobs must run in exactly ONE process. Two of
 * them poll Wialon on the same account, race each other into
 * `Unique constraint failed on (device_id, captured_at)`, and send every
 * alert, mail and push twice. That has happened: two pm2 apps on one checkout
 * (until 2026-08-10), and two boxes on one Wialon account (2026-09-02).
 *
 * The containerization made it easier to repeat. pm2 stays installed as the
 * fallback, so `pm2 resurrect` or a re-enabled pm2-ubuntu.service would start a
 * second server beside the containers. The box scripts refuse to do that
 * themselves, but a person can still do it.
 *
 * So the guarantee lives in the database both of them share: a Postgres
 * SESSION advisory lock, taken at boot on a connection of its own and held for
 * the life of the process.
 *   - The first server takes it and runs normally.
 *   - A second one waits up to LEADER_LOCK_WAIT_S for it (a deploy's old
 *     process may still be shutting down), then exits before it has started
 *     anything. pm2 or Docker restarts it, and it keeps failing loudly.
 *   - When a process dies, the kernel closes its socket and Postgres releases
 *     the lock at once, so a redeploy or a cutover never waits on a dead holder.
 *   - If the lock's own connection drops (an RDS failover, a network cut), this
 *     process can no longer prove it is the only writer. `onLost` fires and the
 *     caller shuts down; the restart takes the lock again.
 *   - A connection can also die SILENTLY (a failover, an idle-session timeout,
 *     a half-open socket): Postgres has already released the lock while this
 *     process would not notice for hours. So every HEARTBEAT_MS the lock's own
 *     session confirms it still holds the lock, with a client-side timeout; a
 *     wrong answer, an error or a timeout counts as lost.
 *
 * Only instances with POLL_ENABLED take it (see index.ts). The read-only
 * shadow, the preview and CI's boot test run with the poller off and never
 * touch it.
 */

import os from 'node:os'
import pg from 'pg'

/** One key for the whole platform: `hashtext` of this name. */
export const LEADER_LOCK_NAME = 'fleet-server:leader'
/** `application_name` prefix, so a waiting process can say who holds the lock. */
export const LEADER_APP_PREFIX = 'fleet-leader:'

export interface LockClient {
  connect(): Promise<unknown>
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
  end(): Promise<void>
  on(event: 'error' | 'end', listener: (...args: unknown[]) => void): unknown
}

export interface LockLog {
  info(obj: object, msg: string): void
  warn(obj: object, msg: string): void
  error(obj: object, msg: string): void
}

export interface LeaderLockOptions {
  connectionString: string
  /** How often the held lock is re-confirmed (default 30 s). */
  heartbeatMs?: number
  /** Schedules the heartbeat; returns a stop function (injectable for tests). */
  every?: (ms: number, fn: () => void) => () => void
  waitMs: number
  log: LockLog
  /** The lock's connection went away while held: this process must stop. */
  onLost: (err?: unknown) => void
  retryMs?: number
  makeClient?: (connectionString: string, applicationName: string) => LockClient
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface LeaderLock {
  /** Ends the lock's session, which releases the lock. Safe to call twice. */
  release(): Promise<void>
}

export class LeaderLockTimeout extends Error {
  constructor(public readonly waitedMs: number, public readonly holders: string[]) {
    super(`another fleet-server holds the leader lock (${holders.join('; ') || 'holder unknown'}); waited ${Math.round(waitedMs / 1000)} s`)
    this.name = 'LeaderLockTimeout'
  }
}

const defaultClient = (connectionString: string, applicationName: string): LockClient =>
  // query_timeout: a heartbeat on a dead socket must fail, not hang forever.
  new pg.Client({ connectionString, application_name: applicationName, keepAlive: true, query_timeout: 10_000 }) as unknown as LockClient

const defaultEvery = (ms: number, fn: () => void) => {
  const t = setInterval(fn, ms)
  t.unref()
  return () => clearInterval(t)
}

const STILL_HELD = `SELECT count(*)::int AS n FROM pg_locks
  WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()`

/** Postgres limits application_name to 63 bytes. */
export function leaderAppName(host = os.hostname(), pid = process.pid): string {
  return `${LEADER_APP_PREFIX}${host}:${pid}`.slice(0, 63)
}

export async function acquireLeaderLock(opts: LeaderLockOptions): Promise<LeaderLock> {
  const retryMs = opts.retryMs ?? 5_000
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const now = opts.now ?? Date.now
  const appName = leaderAppName()
  const client = (opts.makeClient ?? defaultClient)(opts.connectionString, appName)

  let held = false
  let released = false
  let lostReported = false
  let stopHeartbeat = () => {}
  const lost = (err?: unknown) => {
    if (!held || released || lostReported) return
    lostReported = true
    stopHeartbeat()
    opts.log.error({ err }, 'Leader lock connection lost: this process can no longer prove it is the only writer, shutting down')
    opts.onLost(err)
  }
  // Attached before connect: an error event with no listener would crash the process.
  client.on('error', lost)
  client.on('end', () => lost())

  await client.connect()
  const started = now()
  let reported = false
  for (;;) {
    const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [LEADER_LOCK_NAME])
    if (rows[0]?.['ok'] === true) {
      held = true
      opts.log.info({ lock: LEADER_LOCK_NAME, as: appName, waitedMs: now() - started }, 'Leader lock held: this process runs the poller and background jobs')
      let beating = false
      stopHeartbeat = (opts.every ?? defaultEvery)(opts.heartbeatMs ?? 30_000, () => {
        if (beating || released || lostReported) return
        beating = true
        client.query(STILL_HELD)
          .then(r => { if (Number(r.rows[0]?.['n'] ?? 0) < 1) lost(new Error('the session no longer holds the leader lock')) })
          .catch(err => lost(err))
          .finally(() => { beating = false })
      })
      return {
        async release() {
          if (released) return
          released = true
          stopHeartbeat()
          await client.end().catch(() => {})
        },
      }
    }
    const holders = await holdersOf(client)
    const waited = now() - started
    if (waited >= opts.waitMs) {
      await client.end().catch(() => {})
      throw new LeaderLockTimeout(waited, holders)
    }
    if (!reported) {
      reported = true
      opts.log.warn({ lock: LEADER_LOCK_NAME, holders, waitS: Math.round(opts.waitMs / 1000) },
        'Leader lock is held by another fleet-server: waiting for it before starting anything')
    }
    await sleep(retryMs)
  }
}

/** Who else holds a leader session: application name, address, since when. */
async function holdersOf(client: LockClient): Promise<string[]> {
  try {
    const { rows } = await client.query(
      `SELECT application_name, client_addr::text AS addr, backend_start
         FROM pg_stat_activity
        WHERE application_name LIKE $1 AND pid <> pg_backend_pid()`,
      [`${LEADER_APP_PREFIX}%`],
    )
    return rows.map(r => `${String(r['application_name'])} from ${String(r['addr'] ?? '?')} since ${new Date(String(r['backend_start'])).toISOString()}`)
  } catch {
    return []
  }
}
