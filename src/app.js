import cors from 'cors'
import express from 'express'
import { env } from './config/env.js'
import { errorHandler } from './middleware/errorHandler.js'
import { notFound } from './middleware/notFound.js'
import { requestLogger } from './middleware/requestLogger.js'
import { requestIdMiddleware } from './middleware/requestId.js'
import { apiRouter } from './routes/index.js'

const app = express()

// Request Correlation ID (Phase 2.4G)
app.use(requestIdMiddleware)

// Security Baseline Headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-XSS-Protection', '1; mode=block')
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  next()
})

// CORS Configuration — production allowlist only; localhost/preview only outside production
const productionOrigins = [
  'https://svhub.shop',
  'https://www.svhub.shop',
  env.CLIENT_ORIGIN,
  env.CLIENT_URL,
].filter(Boolean)

const developmentOrigins = [
  ...productionOrigins,
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
].filter(Boolean)

const isProduction = env.NODE_ENV === 'production'
const allowedOrigins = isProduction ? productionOrigins : developmentOrigins

function isAllowedOrigin(origin) {
  if (!origin) return true
  if (allowedOrigins.includes(origin)) return true
  if (!isProduction) {
    if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true
    if (/^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return true
  }
  return false
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin)) {
        return callback(null, true)
      }
      // Reject without throwing — avoids CORS denials becoming HTTP 500
      return callback(null, false)
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Request-Id', 'X-Razorpay-Signature'],
  }),
)

// Webhook Route-Specific Raw Body Parser (Phase 2.4C)
// Preserves exact unaltered bytes on req.body (as Buffer) and req.rawBody specifically for Razorpay webhooks
app.use(
  '/api/payments/razorpay/webhook',
  express.raw({ type: '*/*', limit: '1mb' }),
  (req, res, next) => {
    if (Buffer.isBuffer(req.body)) {
      req.rawBody = req.body
    }
    next()
  },
)

// Standard Body Parsers with safe payload limits
app.use(
  express.json({
    limit: '1mb',
    verify: (req, res, buf) => {
      if (req.originalUrl?.includes?.('/webhook')) {
        req.rawBody = buf
      }
    },
  }),
)
app.use(express.urlencoded({ extended: true, limit: '1mb' }))

// Request Logger (never logs sensitive data)
app.use(requestLogger)

// Mount Centralized API Router
app.use('/api', apiRouter)

// Direct root health ping
app.get('/health', (req, res) => {
  res.redirect(301, '/api/health')
})

// 404 Not Found Handler
app.use(notFound)

// Global Centralized Error Handler
app.use(errorHandler)

export { app }
