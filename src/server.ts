import { buildApp } from './app';
import { env } from './config/env';
import { prisma } from './plugins/prisma';

async function main() {
  const app = await buildApp();
  const shutdown = async () => { await app.close(); await prisma.$disconnect(); process.exit(0); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}
main().catch(error => { console.error('Server startup failed', error); process.exit(1); });
