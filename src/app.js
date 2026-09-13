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

// CORS Configuration
const allowedOrigins = [
  env.CLIENT_ORIGIN,
  env.CLIENT_URL,
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://svhub-frontend-nine.vercel.app',
  'https://svhub.shop',
  'https://www.svhub.shop',
].filter(Boolean)

function isAllowedOrigin(origin) {
  if (!origin) return true
  if (allowedOrigins.includes(origin)) return true
  if (origin.endsWith('.vercel.app')) return true
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true
  if (/^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return true
  return false
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin) || env.NODE_ENV === 'development') {
        return callback(null, true)
      }
      return callback(new Error('Blocked by CORS policy'))
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
