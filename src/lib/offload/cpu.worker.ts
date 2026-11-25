/**
 * A worker thread of the CPU pool (./cpu-pool.ts): runs one task at a time
 * and posts back its result, moving the bytes rather than copying them.
 */

import { parentPort } from 'node:worker_threads'
import { runTask, TaskError, type TaskKind } from './cpu-tasks.js'

if (!parentPort) throw new Error('cpu.worker must run as a worker thread')
const port = parentPort

/** The ArrayBuffers in a result that can be handed over without a copy. */
function transferable(result: unknown): ArrayBuffer[] {
  if (result instanceof Uint8Array) return result.buffer instanceof ArrayBuffer ? [result.buffer] : []
  if (result && typeof result === 'object') {
    return Object.values(result).flatMap((v) => (v instanceof Uint8Array && v.buffer instanceof ArrayBuffer ? [v.buffer] : []))
  }
  return []
}

port.on('message', async (m: { id: number; kind: TaskKind; input: never }) => {
  try {
    const result = await runTask(m.kind, m.input)
    port.postMessage({ id: m.id, ok: true, result }, transferable(result))
  } catch (err) {
    const e = err as Error
    port.postMessage({
      id: m.id, ok: false,
      error: e instanceof TaskError
        ? { name: 'TaskError', message: e.message, status: e.status, issues: e.issues }
        : { name: e?.name ?? 'Error', message: e?.message ?? String(err) },
    })
  }
})
