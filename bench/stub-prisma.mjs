/**
 * A Prisma client that answers instantly and touches nothing.
 *
 * ## Why this exists
 *
 * There is no local Postgres on this machine — no Docker, no psql, and
 * `.env.example` points DATABASE_URL at localhost:15432, which is the SSH
 * TUNNEL to the production RDS rather than a local database. Booting the real
 * server locally would therefore either fail to connect or, with the tunnel up,
 * put benchmark load on the production database from a "local" test. That is
 * the back door this stub closes.
 *
 * Seeded into `globalThis.prisma` before the app is imported, it is picked up
 * by src/lib/prisma.ts's singleton (`globalForPrisma.prisma ?? createPrismaClient()`),
 * so no pg pool is ever constructed and no socket is ever opened.
 *
 * ## What the numbers from it mean, and what they do not
 *
 * Every query returns in microseconds. So a run against this measures the
 * FRAMEWORK: socket accept, routing, middleware, auth, rate limiting, zod
 * validation, serialisation. That is a real and useful number — it is the
 * ceiling the app can never exceed no matter how fast the database gets, and
 * it is where you look when you want to know whether Express or Postgres is
 * the thing in your way.
 *
 * It is NOT a prediction of production latency. Real handlers spend most of
 * their wall time in Postgres, and this deletes all of it. Anything claiming
 * to measure query cost or true write throughput needs a real database; see
 * bench/README.md, which says so at the top.
 *
 * ## Shapes, not nulls
 *
 * A Proxy that returned undefined for everything would fail before reaching
 * the code worth measuring — `rows.length` on undefined, an auth lookup that
 * 401s, and a benchmark of the error path instead of the handler. So the
 * defaults mirror what Postgres can actually produce: a list query answers
 * with an empty array, never undefined, because a SELECT always returns a
 * result set. Counts answer 0. Single-row lookups answer a synthetic record
 * rather than null, so authentication succeeds and the request reaches the
 * handler.
 */

/** The account every bypassed request runs as. Shaped to satisfy auth.ts. */
export const BENCH_USER = {
  id: 'bench-user-0000-0000-000000000000',
  email: 'bench@localhost',
  fullName: 'Benchmark User',
  status: 'ACTIVE',
  organisationId: 'bench-org-0000-0000-000000000000',
  passwordHash: null,
  passwordChangeCount: 1,
  passwordChangedAt: new Date(0),
  createdAt: new Date(0),
  updatedAt: new Date(0),
  organisation: {
    id: 'bench-org-0000-0000-000000000000',
    name: 'Benchmark Org',
    code: 'BENCH',
  },
  userRoles: [],
  memberships: [],
}

/** Delegate methods that return a LIST. Postgres answers a SELECT with a set. */
const LIST_METHODS = new Set(['findMany'])
/** Delegate methods that return a COUNT. */
const COUNT_METHODS = new Set(['count'])
/** Delegate methods that return ONE row, or null in real life. */
const ONE_METHODS = new Set([
  'findUnique', 'findFirst', 'findUniqueOrThrow', 'findFirstOrThrow',
  'create', 'update', 'upsert', 'delete',
])
/** Delegate methods that return a batch payload. */
const BATCH_METHODS = new Set(['createMany', 'updateMany', 'deleteMany'])

/**
 * One model delegate. `model` is carried only so a future caller can make the
 * answer depend on which table was asked — today every table answers the same
 * way, and the user delegate is special-cased by the caller below.
 */
function delegate(model) {
  return new Proxy({}, {
    get(_t, method) {
      if (typeof method !== 'string') return undefined
      return async () => {
        if (LIST_METHODS.has(method))  return []
        if (COUNT_METHODS.has(method)) return 0
        if (BATCH_METHODS.has(method)) return { count: 0 }
        if (ONE_METHODS.has(method)) {
          if (model === 'user') return BENCH_USER
          // An ACTIVE, unexpired ingest key. Without the isActive/expiresAt
          // fields the ingest middleware 401s and the benchmark measures the
          // rejection path rather than the write path.
          if (model === 'ingestApiKey') return {
            id: 'bench-key-0', organisationId: BENCH_USER.organisationId,
            isActive: true, expiresAt: null,
          }
          return { id: `${model}-0` }
        }
        if (method === 'aggregate')    return { _count: 0, _sum: {}, _avg: {}, _min: {}, _max: {} }
        if (method === 'groupBy')      return []
        return null
      }
    },
  })
}

export function createStubPrisma() {
  const cache = new Map()

  const client = new Proxy({}, {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined

      // Client-level methods, not model delegates.
      switch (prop) {
        case '$connect':
        case '$disconnect':
          return async () => {}
        case '$queryRaw':
        case '$queryRawUnsafe':
          return async () => []
        case '$executeRaw':
        case '$executeRawUnsafe':
          return async () => 0
        case '$transaction':
          // Both forms: an array of promises, and an interactive callback that
          // is handed a client — code doing `tx.thing.findMany()` inside a
          // transaction is otherwise calling a method on undefined.
          return async (input) =>
            Array.isArray(input) ? Promise.all(input) : input(client)
        case '$on':
        case '$use':
          return () => {}
        case '$extends':
          return () => client
        case 'then':
          // Must not look thenable, or `await import()` of a module holding it
          // will try to resolve it as a promise and hang.
          return undefined
        default:
          break
      }

      if (!cache.has(prop)) cache.set(prop, delegate(prop))
      return cache.get(prop)
    },
  })

  return client
}
