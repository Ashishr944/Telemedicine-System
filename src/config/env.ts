import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(20).default(3),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().default('amrutam-api'),
  JWT_AUDIENCE: z.string().default('amrutam-client'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['fatal','error','warn','info','debug','trace','silent']).default('info'),
  MOCK_PAYMENT_SECRET: z.string().min(16).default('local-mock-secret-change-this'),
  MFA_ENCRYPTION_KEY: z.string().min(32).optional()
});

export const env = schema.parse(process.env);
if (env.NODE_ENV === 'production' && !env.MFA_ENCRYPTION_KEY) throw new Error('MFA_ENCRYPTION_KEY is required in production');
