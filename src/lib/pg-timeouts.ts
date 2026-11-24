/**
 * Timeouts every application pg pool opens its connections with.
 *
 * `query_timeout` is the CLIENT giving up: pg rejects the promise, but nothing
 * tells the server, so the statement keeps running on RDS. Measured 2026-11-24:
 * "distance covered today" queries were still running 61-75 s after the client
 * had abandoned them at 60 s, and because the warm cache clears its in-flight
 * entry on the rejection, the next read started another copy beside them, up to
 * three of the same statement at once. Load fed itself.
 *
 * `statement_timeout` is the SERVER giving up, so it is set a little under the
 * client's: the database cancels the statement itself (SQLSTATE 57014) and the
 * client gets that error, instead of a timeout with the work still running.
 * The client timeout stays as the guard for a socket that died silently, where
 * no server-side setting can fire.
 *
 * `idle_in_transaction_session_timeout`: the RDS default is 24 h, so a
 * transaction left open by a crashed request would hold its snapshot (and its
 * locks) for a day. No transaction in this app idles for a minute.
 *
 * A statement that needs longer sets its own with SET LOCAL inside a
 * transaction (telemetry.repository does, lower). Migrations and the scripts
 * under prisma/ open their own connections and are not affected.
 */
export const PG_POOL_TIMEOUTS = {
  query_timeout: 60_000,
  statement_timeout: 55_000,
  idle_in_transaction_session_timeout: 60_000,
} as const
