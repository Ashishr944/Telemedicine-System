# Deploying the API to Vercel

Vercel recognizes `src/server.ts` as the Fastify entry point and runs the application as one Node.js Function. `vercel.json` selects Mumbai (`bom1`); the function duration follows the limit for the linked Vercel plan. Keep the PostgreSQL database in the same region where possible. Region selection helps latency; it does not by itself satisfy data-residency, privacy, or healthcare obligations.

References: [Fastify on Vercel](https://vercel.com/docs/frameworks/backend/fastify), [Vercel Function regions](https://vercel.com/docs/functions/configuring-functions/region), and [Vercel environment variables](https://vercel.com/docs/cli/env).

## Before deploying

Create managed PostgreSQL in the chosen region. Use the provider's TLS-enabled pooled connection URL (PgBouncer or equivalent) for application traffic. The Prisma PostgreSQL adapter has a small per-instance pool controlled by `DB_POOL_MAX` (default 3) to avoid multiplying large connection pools as functions scale. Set the database/provider connection limit with Vercel concurrency in mind. Use a separate database for Preview deployments; never let Preview deployments run against production patient data.

Configure these variables in Vercel Project Settings for Development, Preview, and Production as appropriate:

| Variable | Required value |
| --- | --- |
| `DATABASE_URL` | TLS-enabled pooled PostgreSQL URL, including the correct schema |
| `JWT_SECRET` | Unique random secret, at least 32 characters |
| `MFA_ENCRYPTION_KEY` | Separate random secret, at least 32 characters |
| `CORS_ORIGINS` | Comma-separated exact HTTPS origins for the approved client apps |
| `JWT_ISSUER` | Stable issuer, for example `amrutam-api` |
| `JWT_AUDIENCE` | Stable intended client audience, for example `amrutam-client` |
| `DB_POOL_MAX` | Optional small integer; default `3`, maximum `20` |
| `LOG_LEVEL` | `info` or `warn` |

`REDIS_URL` currently defaults to localhost and is not on the booking correctness path. Do not set it to localhost in Vercel. The current API does not use Redis for distributed rate limiting or workers, so those capabilities need a deliberate implementation before relying on Redis in production. Do not put secrets in source control, build output, or screenshots.

## Deploy

Install Node.js 22 and the Vercel CLI, authenticate, then link this checkout to the intended Vercel project:

```sh
npm install --global vercel
vercel login
vercel link
```

Apply database migrations from a controlled operator/CI environment before shifting production traffic. The command reads the linked Vercel Production variables without writing them to a local file:

```sh
vercel env run -e production -- npx prisma migrate deploy
```

For Preview, use a separate preview database and run the same command with `-e preview`. Deploy a preview first, then promote only after checking health, auth, and booking against non-production data:

```sh
vercel
vercel --prod
```

The package `vercel-build` script generates Prisma Client and compiles the TypeScript project. For local Vercel emulation, run `vercel dev` after linking and configuring Development variables. Check `/health/live`, `/health/ready`, `/docs`, and `/metrics` on the deployment. Swagger uses Vercel's production URL or deployment URL automatically.

## Operational limits

This makes the existing API deployable as a Vercel Function; it does not make the MVP production-ready for telemedicine. Rate limits are in-memory per process and are not a distributed abuse-control boundary. The project does not implement prescription or payment routes, a payment provider, background outbox workers, email delivery, or full tracing. Keep the metrics endpoint behind appropriate access/network controls, configure database backups and tested restore procedures, and complete a qualified security/privacy review before handling real health data. Verify the selected Vercel plan's function limits and service region availability before deployment.
