import { describe, it, expect } from 'vitest'
import { lateNote, lateSpan } from '../../src/lib/notifications/late-note.js'

const AT = new Date('2026-10-22T03:00:00Z')
const after = (min: number) => new Date(AT.getTime() + min * 60_000)

describe('lateNote', () => {
  it('is empty while the line is on time for its kind', () => {
    expect(lateNote(AT, after(30), 30 * 60_000, 'x')).toBe('')
    expect(lateNote(AT, after(59), 60 * 60_000, 'x')).toBe('')
  })

  it('says how long after the event, and why', () => {
    expect(lateNote(AT, after(45), 30 * 60_000, 'the tracker sent these readings late'))
      .toBe(' Reported 45 minutes after it happened: the tracker sent these readings late.')
  })

  it('reads in hours past an hour and a half, whole hours past ten', () => {
    expect(lateSpan(89 * 60_000)).toBe('89 minutes')
    expect(lateSpan(90 * 60_000)).toBe('1.5 hours')
    expect(lateSpan(20 * 3_600_000)).toBe('20 hours')
    expect(lateSpan(48.4 * 3_600_000)).toBe('48 hours')
  })
})
