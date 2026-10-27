import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../common/errors';
import { prisma } from '../../plugins/prisma';
import { authenticate } from '../../common/authenticate';

export async function analyticsRoutes(app: FastifyInstance) {
  app.get('/consultations', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async req => {
    const actor = await authenticate(req);
    if (actor.role !== 'ADMIN') throw new AppError(403, 'Administrator role required', 'FORBIDDEN');
    const { from, to } = z.object({ from: z.string().datetime(), to: z.string().datetime() }).parse(req.query);
    const start = new Date(from), end = new Date(to);
    if (start >= end || end.getTime() - start.getTime() > 366 * 86400000) throw new AppError(400, 'Date range must be ordered and no longer than 366 days', 'INVALID_DATE_RANGE');
    const where = { createdAt: { gte: start, lt: end } };
    const [total, grouped] = await Promise.all([
      prisma.consultation.count({ where }),
      prisma.consultation.groupBy({ by: ['status'], where, _count: { _all: true } })
    ]);
    const outcomes = Object.fromEntries(grouped.map(row => [row.status.toLowerCase(), row._count._all]));
    return { data: { total, outcomes, cancellationRate: total === 0 ? 0 : (outcomes.cancelled ?? 0) / total }, requestId: req.id };
  });
}
