/**
 * Bundle a signal-alert harness into one CommonJS file that runs on the box.
 *
 *   node prisma/signal-alerts.build.mjs [entry] [outfile]
 *
 * Defaults to the replay (`prisma/signal-alerts-replay.ts` → signal-replay.cjs);
 * the live shadow run is `prisma/signal-alerts-live.ts`.
 *
 * `pg` and `dotenv` stay external and resolve from the deployed checkout's
 * node_modules (NODE_PATH). `src/config/env` is replaced by a stub: the only
 * thing the bundled code reads from it is the live watch's enable flag, and
 * loading the real module would validate — and on failure exit on — the
 * application's whole configuration, which a read-only replay has no business
 * touching. The harness reads the box's real flag itself and reports it.
 */

import { build } from 'esbuild'

const entry = process.argv[2] ?? 'prisma/signal-alerts-replay.ts'
const outfile = process.argv[3] ?? 'signal-replay.cjs'

await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile,
  external: ['pg', 'dotenv'],
  logLevel: 'warning',
  plugins: [{
    name: 'env-stub',
    setup(b) {
      b.onResolve({ filter: /config\/env(\.js)?$/ }, a => ({ path: a.path, namespace: 'env-stub' }))
      b.onLoad({ filter: /.*/, namespace: 'env-stub' }, () => ({
        contents: 'export const env = { LIVE_FUEL_WATCH_ENABLED: true }',
        loader: 'js',
      }))
    },
  }],
})

console.log(`built ${outfile}`)
