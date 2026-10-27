import { FastifyInstance } from 'fastify';
import { prisma } from '../../plugins/prisma';
import { AppError } from '../../common/errors';
import { authenticate } from '../../common/authenticate';

export async function userRoutes(app: FastifyInstance) {
  app.get('/me', async req => {
    const actor = await authenticate(req);
    const user = await prisma.user.findUnique({ where: { id: actor.sub }, select: { id: true, email: true, role: true, status: true, createdAt: true, patient: true, doctor: true } });
    if (!user) throw new AppError(404, 'User not found', 'NOT_FOUND');
    return { data: user, requestId: req.id };
  });
}
