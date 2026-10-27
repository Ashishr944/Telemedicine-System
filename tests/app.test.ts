import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
beforeAll(async () => {
  process.env.DATABASE_URL ??= 'postgresql://amrutam:local_password@127.0.0.1:5432/amrutam';
  process.env.JWT_SECRET ??= 'unit-test-secret-that-has-more-than-32-characters';
  process.env.NODE_ENV = 'test';
  const { buildApp } = await import('../src/app');
  app = await buildApp({ logger: false });
});
afterAll(async () => { await app.close(); });

describe('HTTP basics', () => {
  it('serves liveness without touching dependencies', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('live');
  });
  it('returns a safe validation error for malformed registration', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'invalid' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(response.body).not.toContain('stack');
  });
  it('exposes request metrics', async () => {
    const response = await app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('http_requests_total');
  });
  it('publishes route paths in OpenAPI', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(response.statusCode).toBe(200);
    const document = response.json();
    expect(document.openapi).toMatch(/^3\.1/);
    expect(document.paths['/health/live']).toBeDefined();
    expect(document.paths['/api/v1/admin/analytics/consultations']).toBeDefined();
  });
  it('protects admin analytics and self profile routes', async () => {
    const analytics = await app.inject({ method: 'GET', url: '/api/v1/admin/analytics/consultations?from=2026-10-01T00:00:00.000Z&to=2026-10-26T00:00:00.000Z' });
    const profile = await app.inject({ method: 'GET', url: '/api/v1/users/me' });
    expect(analytics.statusCode).toBe(401);
    expect(profile.statusCode).toBe(401);
  });
});
