import { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../plugins/prisma';
import { AppError } from '../../common/errors';
import { authenticate } from '../../common/authenticate';

const transitions: Record<string, string[]> = { SCHEDULED: ['CONFIRMED','CANCELLED'], CONFIRMED: ['IN_PROGRESS','CANCELLED','NO_SHOW'], IN_PROGRESS: ['COMPLETED'], COMPLETED: [], CANCELLED: [], NO_SHOW: [] };

export async function consultationRoutes(app: FastifyInstance) {
  app.post('/', async (req, reply) => {
    const actor = await authenticate(req);
    if (actor.role !== 'PATIENT') throw new AppError(403, 'Patient role required', 'FORBIDDEN');
    const key = z.string().min(8).max(200).parse(req.headers['idempotency-key']);
    const body = z.object({ slotId: z.string().uuid() }).parse(req.body);
    const fingerprint = createHash('sha256').update(JSON.stringify({ method: req.method, path: req.url, actor: actor.sub, body })).digest('hex');
    try {
      const result = await prisma.$transaction(async tx => {
        const existing = await tx.idempotencyKey.findUnique({ where: { key } });
        if (existing) {
          if (existing.expiresAt <= new Date()) await tx.idempotencyKey.delete({ where: { key } });
          else {
          if (existing.actorId !== actor.sub || existing.fingerprint !== fingerprint) throw new AppError(409, 'Idempotency key reused with different request', 'IDEMPOTENCY_CONFLICT');
          if (existing.responseBody) return { body: existing.responseBody };
          throw new AppError(409, 'An identical request is still processing; retry shortly', 'REQUEST_IN_PROGRESS');
          }
        }
        await tx.idempotencyKey.create({ data: { key, actorId: actor.sub, method: req.method, path: req.url, fingerprint, expiresAt: new Date(Date.now() + 86400000) } });
        const slot = await tx.availabilitySlot.findUnique({ where: { id: body.slotId }, include: { doctor: { include: { user: true } } } });
        if (!slot || slot.cancelledAt || slot.startsAt <= new Date() || !slot.doctor.verified || slot.doctor.user.status !== 'ACTIVE') throw new AppError(409, 'Availability is no longer bookable', 'SLOT_UNAVAILABLE');
        const row = await tx.consultation.create({ data: { patientId: actor.sub, doctorId: slot.doctorId, slotId: slot.id, feeMinor: slot.doctor.feeMinor, currency: slot.doctor.currency } });
        await tx.auditLog.create({ data: { actorId: actor.sub, action: 'consultation.booked', resourceType: 'consultation', resourceId: row.id, correlationId: req.id } });
        await tx.outboxEvent.create({ data: { eventType: 'consultation.booked', aggregateId: row.id, payload: { consultationId: row.id } } });
        const responseBody = { data: row, requestId: req.id };
        await tx.idempotencyKey.update({ where: { key }, data: { responseStatus: 201, responseBody } });
        return { body: responseBody };
      }, { isolationLevel: 'Serializable' });
      return reply.code(201).send(result.body);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'P2002') {
        const winner = await prisma.idempotencyKey.findUnique({ where: { key } });
        if (winner?.actorId === actor.sub && winner.fingerprint === fingerprint && winner.responseBody) return reply.code(winner.responseStatus ?? 201).send(winner.responseBody);
        throw new AppError(409, 'Availability or idempotency key was claimed by another request', 'SLOT_CONFLICT');
      }
      if (typeof error === 'object' && error !== null && 'code' in error && (error as { code: string }).code === 'P2034') throw new AppError(409, 'Concurrent booking conflict; retry with the same Idempotency-Key', 'SLOT_CONFLICT');
      throw error;
    }
  });
  app.get('/', async req => {
    const user = await authenticate(req);
    const where = user.role === 'PATIENT' ? { patientId: user.sub } : user.role === 'DOCTOR' ? { doctorId: user.sub } : {};
    return { data: await prisma.consultation.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 }), requestId: req.id };
  });
  app.patch('/:id/status', async (req) => {
    const user = await authenticate(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { status } = z.object({ status: z.enum(['CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED','NO_SHOW']) }).parse(req.body);
    const current = await prisma.consultation.findUnique({ where: { id } });
    if (!current || (user.role === 'PATIENT' && current.patientId !== user.sub) || (user.role === 'DOCTOR' && current.doctorId !== user.sub)) throw new AppError(404, 'Consultation not found', 'NOT_FOUND');
    if (user.role === 'PATIENT' && status !== 'CANCELLED') throw new AppError(403, 'Patients may only cancel consultations', 'FORBIDDEN');
    if (user.role === 'PATIENT' && current.slotId) {
      const scheduledSlot = await prisma.availabilitySlot.findUnique({ where: { id: current.slotId }, select: { startsAt: true } });
      if (scheduledSlot && scheduledSlot.startsAt.getTime() - Date.now() < 24 * 60 * 60 * 1000) throw new AppError(409, 'Patient cancellation is available until 24 hours before the appointment', 'CANCELLATION_WINDOW_CLOSED');
    }
    if (!transitions[current.status]?.includes(status)) throw new AppError(409, 'Invalid consultation state transition', 'INVALID_TRANSITION');
    const updated = await prisma.$transaction(async tx => {
      const changed = await tx.consultation.updateMany({ where: { id, status: current.status }, data: { status } });
      if (changed.count !== 1) throw new AppError(409, 'Consultation changed concurrently; reload and retry', 'STATE_CONFLICT');
      await tx.auditLog.create({ data: { actorId: user.sub, action: `consultation.${status.toLowerCase()}`, resourceType: 'consultation', resourceId: id, correlationId: req.id } });
      return tx.consultation.findUniqueOrThrow({ where: { id } });
    });
    return { data: updated, requestId: req.id };
  });
}
