import { createClient } from '@supabase/supabase-js'
import { env } from '../../config/env.js'
import { UnauthorizedError } from '../../core/errors/errors.js'
import { prisma } from '../../lib/prisma.js'
import type { LoginDto, RefreshDto } from './auth.schema.js'

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY)

export async function login(dto: LoginDto) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: dto.email,
    password: dto.password,
  })

  if (error || !data.session) throw new UnauthorizedError(error?.message ?? 'Invalid credentials')

  // Resolve the user record in our DB so the client has their internal ID
  const user = await prisma.user.findFirst({
    where: { email: dto.email, deletedAt: null },
    select: { id: true, organisationId: true, email: true, fullName: true, status: true },
  })

  if (!user) throw new UnauthorizedError('No fleet account associated with this email')
  if (user.status !== 'ACTIVE') throw new UnauthorizedError(`Account ${user.status.toLowerCase()}`)

  return {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresIn: data.session.expires_in,
    user,
  }
}

export async function refresh(dto: RefreshDto) {
  const { data, error } = await supabase.auth.refreshSession({ refresh_token: dto.refreshToken })

  if (error || !data.session) throw new UnauthorizedError(error?.message ?? 'Invalid refresh token')

  return {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresIn: data.session.expires_in,
  }
}

export async function logout(accessToken: string) {
  // Sign out the specific session represented by this token
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  })
  await client.auth.signOut()
}
