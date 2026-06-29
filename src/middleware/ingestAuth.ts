import type { RequestHandler } from 'express'
import { createHash } from 'crypto'
import { prisma } from '../lib/prisma.js'
import { UnauthorizedError } from '../core/errors/errors.js'

export const ingestAuth: RequestHandler = async (req, _res, next) => {
  try {
    const authHeader = req.headers['authorization']
    if (!authHeader?.startsWith('Bearer ')) {
      return next(new UnauthorizedError('Missing ingest API key'))
    }

    const rawKey = authHeader.slice(7)
    const keyHash = createHash('sha256').update(rawKey).digest('hex')

    const apiKey = await prisma.ingestApiKey.findUnique({
      where: { keyHash },
      select: { id: true, organisationId: true, isActive: true, expiresAt: true },
    })

    if (!apiKey || !apiKey.isActive) {
      return next(new UnauthorizedError('Invalid or inactive API key'))
    }
    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      return next(new UnauthorizedError('API key expired'))
    }

    req.ingestOrg = { id: apiKey.organisationId, apiKeyId: apiKey.id }

    // Fire-and-forget — update lastUsedAt without blocking the response
    prisma.ingestApiKey
      .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined)

    next()
  } catch (err) {
    next(err)
  }
}
