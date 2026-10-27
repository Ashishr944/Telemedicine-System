import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { Registry, collectDefaultMetrics, Counter, Histogram } from 'prom-client';
import { env } from './config/env';
import { AppError } from './common/errors';
import { prisma } from './plugins/prisma';
import { authRoutes } from './modules/auth/routes';
import { consultationRoutes } from './modules/consultations/routes';
import { doctorRoutes } from './modules/doctors/routes';
import { availabilityRoutes } from './modules/availability/routes';
import { userRoutes } from './modules/users/routes';
import { analyticsRoutes } from './modules/analytics/routes';

declare module '@fastify/jwt' { interface FastifyJWT { user: { sub: string; role: 'PATIENT'|'DOCTOR'|'ADMIN' } } }

export async function buildApp(options: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? { level: env.LOG_LEVEL, redact: ['req.headers.authorization','req.headers.cookie','req.url','req.remoteAddress','*.password','*.passwordHash','*.token','*.refreshToken','*.secret','*.secretEncrypted','*.email','*.fullName','*.phone','*.notes','*.medicine','*.dosage'] }, bodyLimit: 1024 * 1024, requestTimeout: 15000, genReqId: () => crypto.randomUUID() });
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const requests = new Counter({ name: 'http_requests_total', help: 'HTTP requests', labelNames: ['method','route','status'] });
  const duration = new Histogram({ name: 'http_request_duration_seconds', help: 'HTTP request duration', labelNames: ['method','route'], buckets: [0.01,0.05,0.1,0.2,0.5,1,2] });
  registry.registerMetric(requests); registry.registerMetric(duration);

  await app.register(helmet);
  await app.register(cors, { origin: env.CORS_ORIGINS.split(',').map(v => v.trim()), credentials: true });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await app.register(jwt, { secret: env.JWT_SECRET, sign: { algorithm: 'HS256', expiresIn: '10m', iss: env.JWT_ISSUER, aud: env.JWT_AUDIENCE }, verify: { algorithms: ['HS256'], allowedIss: env.JWT_ISSUER, allowedAud: env.JWT_AUDIENCE, requiredClaims: ['iss', 'aud', 'exp', 'sub'] } });
  const serverUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : `http://localhost:${env.PORT}`;
  await app.register(swagger, { openapi: { info: { title: 'Amrutam API', version: '0.1.0' }, openapi: '3.1.0', servers: [{ url: serverUrl }] } });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.addHook('onRequest', async request => { (request as typeof request & { startedAt: bigint }).startedAt = process.hrtime.bigint(); });
  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unknown';
    requests.labels(request.method, route, String(reply.statusCode)).inc();
    const started = (request as typeof request & { startedAt?: bigint }).startedAt;
    if (started) duration.labels(request.method, route).observe(Number(process.hrtime.bigint() - started) / 1e9);
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message }, requestId: request.id });
    if (error instanceof Error && error.name === 'ZodError') return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed' }, requestId: request.id });
    if (error instanceof Error && 'validation' in error && error.validation) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed' }, requestId: request.id });
    if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      const code = 'code' in error && typeof error.code === 'string' ? error.code : 'REQUEST_FAILED';
      const status = code.startsWith('FST_JWT') ? 401 : error.statusCode;
      const safeCode = status === 401 ? 'UNAUTHORIZED' : status === 429 ? 'RATE_LIMITED' : 'REQUEST_FAILED';
      const message = status === 401 ? 'Authentication required' : status === 429 ? 'Too many requests' : 'Request could not be completed';
      return reply.code(status).send({ error: { code: safeCode, message }, requestId: request.id });
    }
    request.log.error({ err: error, requestId: request.id }, 'request failed');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' }, requestId: request.id });
  });

  app.get('/health/live', async () => ({ data: { status: 'live' } }));
  app.get('/health/ready', async (_req, reply) => {
    try { await prisma.$queryRaw`SELECT 1`; return { data: { status: 'ready' } }; }
    catch { return reply.code(503).send({ error: { code: 'NOT_READY', message: 'Dependencies unavailable' } }); }
  });
  app.get('/metrics', async (_req, reply) => reply.type(registry.contentType).send(await registry.metrics()));
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(userRoutes, { prefix: '/api/v1/users' });
  await app.register(doctorRoutes, { prefix: '/api/v1/doctors' });
  await app.register(availabilityRoutes, { prefix: '/api/v1/availability' });
  await app.register(consultationRoutes, { prefix: '/api/v1/consultations' });
  await app.register(analyticsRoutes, { prefix: '/api/v1/admin/analytics' });
  return app;
}
