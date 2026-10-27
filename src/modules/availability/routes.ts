import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../plugins/prisma';
import { AppError } from '../../common/errors';
import { authenticate } from '../../common/authenticate';

export async function availabilityRoutes(app: FastifyInstance) {
  app.post('/', async (req, reply) => {
    const user = await authenticate(req);
    if (user.role !== 'DOCTOR') throw new AppError(403, 'Doctor role required', 'FORBIDDEN');
    const profile = await prisma.doctorProfile.findUnique({ where: { userId: user.sub }, select: { userId: true } });
    if (!profile) throw new AppError(403, 'Doctor profile is not configured', 'FORBIDDEN');
    const body = z.object({ startsAt: z.string().datetime(), endsAt: z.string().datetime(), timeZone: z.string().min(1).max(100).refine(value => {
      try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
    }, 'timeZone must be a valid IANA timezone') }).parse(req.body);
    const start = new Date(body.startsAt), end = new Date(body.endsAt);
    if (end <= start || start <= new Date()) throw new AppError(400, 'Availability must be in the future and have positive duration', 'INVALID_AVAILABILITY');
    try {
      const slot = await prisma.availabilitySlot.create({ data: { doctorId: user.sub, startsAt: start, endsAt: end, timeZone: body.timeZone } });
      return reply.code(201).send({ data: slot, requestId: req.id });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && ['P2002', 'P2004'].includes((error as { code: string }).code)) throw new AppError(409, 'Availability conflicts with an existing slot', 'AVAILABILITY_CONFLICT');
      throw error;
    }
  });
  app.get('/', async req => {
    const query = z.object({ doctorId: z.string().uuid().optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional() }).parse(req.query);
    return { data: await prisma.availabilitySlot.findMany({ where: { cancelledAt: null, ...(query.doctorId ? { doctorId: query.doctorId } : {}), startsAt: { gte: query.from ? new Date(query.from) : new Date(), ...(query.to ? { lte: new Date(query.to) } : {}) } }, orderBy: { startsAt: 'asc' }, take: 100 }), requestId: req.id };
  });
}
