import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../plugins/prisma';

export async function doctorRoutes(app: FastifyInstance) {
  app.get('/', async (req) => {
    const query = z.object({ specialty: z.string().max(100).optional(), maxFeeMinor: z.coerce.number().int().nonnegative().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20) }).parse(req.query);
    const where = { verified: true, ...(query.maxFeeMinor ? { feeMinor: { lte: query.maxFeeMinor } } : {}), ...(query.specialty ? { specialties: { some: { specialty: { name: { equals: query.specialty, mode: 'insensitive' as const } } } } } : {}) };
    const [items, total] = await Promise.all([prisma.doctorProfile.findMany({ where, skip: (query.page - 1) * query.pageSize, take: query.pageSize, orderBy: [{ feeMinor: 'asc' }, { userId: 'asc' }], select: { userId: true, fullName: true, bio: true, feeMinor: true, currency: true, timeZone: true, specialties: { select: { specialty: { select: { name: true } } } } } }), prisma.doctorProfile.count({ where })]);
    return { data: items, pagination: { page: query.page, pageSize: query.pageSize, total }, requestId: req.id };
  });
}
