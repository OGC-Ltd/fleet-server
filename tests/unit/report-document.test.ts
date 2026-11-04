/** Any report as edited on its page, drawn from the sheet (POST reports/document.pdf). */
import { describe, it, expect } from 'vitest'
import { renderShiftDoc } from '../../src/modules/reports/end-of-shift.pdf.js'
import { reportDocSchema } from '../../src/modules/reports/report.schema.js'

const doc = {
  title: 'TAT AND FUEL REPORT', docName: 'TAT and Fuel Report West Kenya', pairs: true, filename: 'TAT and Fuel Report West Kenya 2026-11-03',
  reportNo: 'TF-WK-20261104-0900', date: '03/11/2026',
  meta: [{ label: 'Fleet', value: 'West Kenya' }, { label: 'Units', value: 'All units' }, { label: 'Day', value: '3 November 2026' }],
  blocks: [
    { kind: 'h2', title: '1. Overview', aside: '3 November 2026' },
    { kind: 'figures', items: [{ label: 'Trips', value: '1' }] },
    { kind: 'bar', title: 'OFFLINE YESTERDAY', aside: '03/11/2026 · 1 vehicle' },
    {
      kind: 'table', size: 6.8,
      cols: Array.from({ length: 14 }, (_, i) => ({ w: 19, wrap: i === 0, ...(i > 1 ? { align: 'right' } : {}) })),
      head: Array.from({ length: 14 }, (_, i) => `C${i}`),
      rows: [Array.from({ length: 14 }, (_, i) => ({ text: `v${i}`, ...(i === 3 ? { link: 'https://www.google.com/maps?q=0.5,34.5', fill: '#c6efce' } : {}) }))],
    },
    { kind: 'note', text: 'Edited by the operator.' },
  ],
  footer: 'West Kenya · TAT and Fuel Report · 03/11/2026',
}

describe('a report drawn from its sheet', () => {
  it('takes fourteen columns, a bar, a link and a tint', async () => {
    const parsed = reportDocSchema.parse(doc)
    const { filename, ...sheet } = parsed
    expect(filename).toBe('TAT and Fuel Report West Kenya 2026-11-03')
    const buf = await renderShiftDoc(sheet, { landscape: true })
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-')
    const text = buf.toString('latin1')
    expect(text).toContain('841.89 595.28')
    expect(text).toContain('google.com/maps')
  })
  it('names the file', () => {
    const { filename: _gone, ...none } = doc
    expect(reportDocSchema.safeParse(none).success).toBe(false)
  })
  it('refuses a link that is not https, and a tint that is not a colour', () => {
    const withCell = (cell: object) => ({ ...doc, blocks: [{ kind: 'table', cols: [{ w: 10 }], head: ['A'], rows: [[{ text: 'x', ...cell }]] }] })
    expect(reportDocSchema.safeParse(withCell({ link: 'javascript:alert(1)' })).success).toBe(false)
    expect(reportDocSchema.safeParse(withCell({ link: 'http://example.com' })).success).toBe(false)
    expect(reportDocSchema.safeParse(withCell({ fill: 'red' })).success).toBe(false)
  })
})
