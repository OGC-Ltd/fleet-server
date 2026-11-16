/**
 * The site's CSP violation reports (modules/csp/csp-report): both browser
 * formats parsed, query strings dropped, repeats logged sparingly.
 */

import { describe, it, expect, vi } from 'vitest'
import { parseCspReports, shouldLog, cspReportHandler } from '../../src/modules/csp/csp-report.js'
import { logger } from '../../src/lib/logger.js'

const LEGACY = {
  'csp-report': {
    'document-uri': 'https://logistics.raioperations.com/map?token=abc#x',
    'violated-directive': 'script-src-elem',
    'effective-directive': 'script-src-elem',
    'blocked-uri': 'https://evil.example/x.js?k=1',
    'source-file': 'https://logistics.raioperations.com/assets/index-AB12.js?v=2',
    'line-number': 12,
    disposition: 'report',
  },
}

const MODERN = [
  { type: 'csp-violation', body: { documentURL: 'https://logistics.raioperations.com/fuel', effectiveDirective: 'connect-src', blockedURL: 'wss://vss.controltech-ea.com:9988/live', disposition: 'report' } },
  { type: 'deprecation', body: { id: 'x' } },
  { type: 'csp-violation', body: { documentURL: 'https://logistics.raioperations.com/', effectiveDirective: 'script-src', blockedURL: 'wasm-eval' } },
]

describe('parseCspReports', () => {
  it('reads report-uri bodies and keeps only origins and paths', () => {
    expect(parseCspReports(LEGACY)).toEqual([{
      directive: 'script-src-elem',
      blocked: 'https://evil.example',
      page: 'https://logistics.raioperations.com/map',
      source: 'https://logistics.raioperations.com/assets/index-AB12.js',
      line: 12,
      disposition: 'report',
    }])
  })

  it('reads report-to bodies, skipping other report types', () => {
    const v = parseCspReports(MODERN)
    expect(v.map((x) => [x.directive, x.blocked])).toEqual([
      ['connect-src', 'wss://vss.controltech-ea.com:9988'],
      ['script-src', 'wasm-eval'],
    ])
  })

  it('ignores anything else', () => {
    for (const b of [null, undefined, 'x', 42, {}, { 'csp-report': 'x' }, [{ type: 'csp-violation' }]]) {
      expect(parseCspReports(b)).toEqual([])
    }
  })
})

describe('shouldLog', () => {
  it('logs the first sighting, then the 10th and 100th', () => {
    const v = { directive: 'img-src', blocked: 'https://t.example', page: 'https://p.example/once', source: null, line: null, disposition: null }
    const logged = Array.from({ length: 120 }, () => shouldLog(v)).filter((r) => r.log).map((r) => r.count)
    expect(logged).toEqual([1, 10, 100])
  })
})

describe('cspReportHandler', () => {
  it('answers 204 and logs a violation', () => {
    const end = vi.fn()
    const res = { status: vi.fn(() => ({ end })) }
    cspReportHandler({ body: { 'csp-report': { ...LEGACY['csp-report'], 'document-uri': 'https://logistics.raioperations.com/handler' } } } as never, res as never, vi.fn())
    expect(res.status).toHaveBeenCalledWith(204)
    expect(end).toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ csp: expect.objectContaining({ directive: 'script-src-elem' }) }), 'csp violation')
  })
})
