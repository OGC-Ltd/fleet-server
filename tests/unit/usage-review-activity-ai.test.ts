import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../../src/config/env.js', () => ({ env: { OPENAI_API_KEY: 'test', OPENAI_MODEL: 'gpt-5-nano', DEEPSEEK_API_KEY: 'test-ds', DEEPSEEK_MODEL: 'deepseek-chat' } }))
vi.mock('../../src/lib/logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
import { aiActivities, aiStatus, cachedActivity, readReply } from '../../src/modules/usage-review/usage-review.activity-ai.js'

const reply = (items: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }] }), { status: 200 })

describe('readReply', () => {
  it('keeps only the groups it knows, by index', () => {
    expect(readReply(JSON.stringify({ items: [{ i: 1, activity: 'Banking' }, { i: 0, activity: 'Spaceport' }, { i: 7, activity: 'Fuel' }] }), 2)).toEqual([null, 'Banking'])
    expect(readReply('not json', 2)).toBeNull()
    expect(readReply('{"nope":1}', 2)).toBeNull()
  })
})

describe('aiActivities', () => {
  beforeEach(() => { vi.restoreAllMocks() })
  it('asks once for a batch, then answers from memory', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(reply([{ i: 0, activity: 'Leisure' }, { i: 1, activity: 'Fuel' }, { i: 2, activity: null }]))
    const got = await aiActivities([{ name: 'Ka mwalimu jim', hint: 'Point of interest' }, { name: 'Rodesa Filling Station' }, { name: 'John Otieno' }, { name: 'KA MWALIMU  JIM' }])
    expect(f).toHaveBeenCalledTimes(1)
    const sent = JSON.parse(JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string).messages[1].content)
    expect(sent).toEqual([{ i: 0, name: 'Ka mwalimu jim', hint: 'Point of interest' }, { i: 1, name: 'Rodesa Filling Station' }, { i: 2, name: 'John Otieno' }])
    expect(got.get('ka mwalimu jim')).toBe('Leisure')
    expect(got.get('rodesa filling station')).toBe('Fuel')
    expect(got.get('john otieno')).toBeNull()
    expect(cachedActivity('Rodesa  filling STATION')).toBe('Fuel')
    const again = await aiActivities([{ name: 'Rodesa Filling Station' }])
    expect(f).toHaveBeenCalledTimes(1)
    expect(again.get('rodesa filling station')).toBe('Fuel')
  })
  it('asks DeepSeek when OpenAI has no credit, and lets OpenAI rest', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).includes('openai') ? new Response('{"error":{"code":"credit_balance_exhausted"}}', { status: 429 }) : reply([{ i: 0, activity: 'Shopping' }]))
    const got = await aiActivities([{ name: 'Sammart Supermarket' }])
    expect(got.get('sammart supermarket')).toBe('Shopping')
    expect(f.mock.calls.map(c => String(c[0]))).toEqual(['https://api.openai.com/v1/chat/completions', 'https://api.deepseek.com/chat/completions'])
    const body = JSON.parse((f.mock.calls[1]![1] as RequestInit).body as string)
    expect(body.model).toBe('deepseek-chat')
    expect(body.reasoning_effort).toBeUndefined()
    await aiActivities([{ name: 'Kenya Women Finance Trust' }])
    expect(f.mock.calls.slice(2).map(c => String(c[0]))).toEqual(['https://api.deepseek.com/chat/completions'])
    expect(aiStatus()).toEqual([
      { name: 'OpenAI', configured: true, resting: true, lastProblem: 'HTTP 429 credit_balance_exhausted' },
      { name: 'DeepSeek', configured: true, resting: false, lastProblem: null },
    ])
  })
  it('leaves names out when no model can answer, and asks again next time', async () => {
    const f = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('busy', { status: 503 }))
    const got = await aiActivities([{ name: 'Webuye County Hospital' }])
    expect(got.has('webuye county hospital')).toBe(false)
    expect(cachedActivity('Webuye County Hospital')).toBeUndefined()
    await aiActivities([{ name: 'Webuye County Hospital' }])
    expect(f.mock.calls.length).toBe(2)
  })
})
