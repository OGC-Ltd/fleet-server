import type { RequestHandler } from 'express'
import { sendSuccess } from '../../core/response/response.js'
import * as authService from './auth.service.js'
import type { LoginDto, RefreshDto } from './auth.schema.js'

export const loginHandler: RequestHandler = async (req, res, next) => {
  try {
    const result = await authService.login(req.body as LoginDto)
    sendSuccess(res, result, 200)
  } catch (err) {
    next(err)
  }
}

export const refreshHandler: RequestHandler = async (req, res, next) => {
  try {
    const result = await authService.refresh(req.body as RefreshDto)
    sendSuccess(res, result, 200)
  } catch (err) {
    next(err)
  }
}

export const logoutHandler: RequestHandler = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.slice(7) ?? ''
    await authService.logout(token)
    sendSuccess(res, null, 200)
  } catch (err) {
    next(err)
  }
}
