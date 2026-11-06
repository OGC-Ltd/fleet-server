/**
 * Feedback on a dashcam alarm (modules/dashcam/dashcam-feedback): what the
 * route accepts before anything is written (operator, 7 Nov 2026).
 */
import { describe, it, expect } from 'vitest'
import { ALARM_ID, VERDICTS, feedbackBodySchema } from '../../src/modules/dashcam/dashcam-feedback.js'

describe('dashcam alarm feedback: the body', () => {
  it('takes a verdict, a note trimmed, and the alarm unit and time', () => {
    const r = feedbackBodySchema.parse({ verdict: 'false_alarm', note: '  driver adjusting mirror  ', vehicleId: 'v1', plate: 'KDX 130Y', alarmAt: '2026-11-07T00:46:32.000Z' })
    expect(r).toEqual({ verdict: 'false_alarm', note: 'driver adjusting mirror', vehicleId: 'v1', plate: 'KDX 130Y', alarmAt: '2026-11-07T00:46:32.000Z' })
    expect(feedbackBodySchema.parse({ verdict: 'genuine' })).toEqual({ verdict: 'genuine', note: '', plate: '' })
    expect(VERDICTS).toEqual(['genuine', 'false_alarm', 'coached'])
  })

  it('refuses no verdict, an unknown one, a long note or anything extra', () => {
    expect(feedbackBodySchema.safeParse({ note: 'x' }).success).toBe(false)
    expect(feedbackBodySchema.safeParse({ verdict: 'maybe' }).success).toBe(false)
    expect(feedbackBodySchema.safeParse({ verdict: 'genuine', note: 'x'.repeat(1001) }).success).toBe(false)
    expect(feedbackBodySchema.safeParse({ verdict: 'genuine', authorName: 'Someone else' }).success).toBe(false)
  })

  it('takes the alarm ids VSS hands out, nothing that could reach another path', () => {
    expect(ALARM_ID.test('3f1c9e2a-77b0-4c1e-9a55-0d6f0e9b1c22')).toBe(true)
    expect(ALARM_ID.test('dev12-2026-11-07T00:46:32.000Z-214')).toBe(true)
    expect(ALARM_ID.test('../file')).toBe(false)
    expect(ALARM_ID.test('a/b')).toBe(false)
    expect(ALARM_ID.test('')).toBe(false)
  })
})
