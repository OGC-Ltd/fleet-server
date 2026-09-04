import { z } from 'zod'

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
})

/**
 * The refresh token normally arrives in the httpOnly `fleet_rt` cookie, which
 * the browser attaches by itself — so the usual request has NO BODY AT ALL.
 *
 * Hence `.optional().default({})`: express.json leaves `req.body` undefined
 * when nothing is posted, and a bare object schema rejects that with a 400,
 * which would make the ordinary browser refresh the one case that fails. The
 * field stays for non-browser callers and for the shape the previous API used.
 */
export const refreshSchema = z
  .object({ refreshToken: z.string().min(1).optional() })
  .optional()
  .default({})

export type LoginDto = z.infer<typeof loginSchema>
export type RefreshDto = z.infer<typeof refreshSchema>
