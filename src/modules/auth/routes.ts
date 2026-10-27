import { FastifyInstance } from 'fastify';
import argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../plugins/prisma';
import { AppError } from '../../common/errors';
import { createTotpSecret, decryptMfaSecret, encryptMfaSecret, verifyTotp } from '../../common/mfa';

const credentials = z.object({ email: z.string().email().max(320).transform(v => v.toLowerCase()), password: z.string().min(12).max(128) });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const hashPassword = (password: string) => argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });

export async function authRoutes(app: FastifyInstance) {
  async function issueSession(userId: string, role: 'PATIENT'|'DOCTOR'|'ADMIN') {
    const accessToken = app.jwt.sign({ sub: userId, role, mfa: true });
    const refreshToken = randomBytes(48).toString('base64url');
    await prisma.refreshToken.create({ data: { tokenHash: sha(refreshToken), familyId: randomUUID(), userId, expiresAt: new Date(Date.now() + 30 * 86400000) } });
    return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn: 600 };
  }

  app.post('/register', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = credentials.extend({ fullName: z.string().min(2).max(200) }).parse(req.body);
    const passwordHash = await hashPassword(body.password);
    const user = await prisma.$transaction(async tx => {
      const created = await tx.user.create({ data: { email: body.email, passwordHash, role: 'PATIENT', patient: { create: { fullName: body.fullName } } }, select: { id: true, email: true, role: true } });
      await tx.auditLog.create({ data: { actorId: created.id, action: 'user.registered', resourceType: 'user', resourceId: created.id, correlationId: req.id } });
      return created;
    });
    return reply.code(201).send({ data: user, requestId: req.id });
  });

  app.post('/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = credentials.extend({ totp: z.string().regex(/^\d{6}$/u).optional() }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email }, include: { mfaCredential: true } });
    if (!user || user.status !== 'ACTIVE' || !(await argon2.verify(user.passwordHash, body.password))) throw new AppError(401, 'Invalid email or password', 'INVALID_CREDENTIALS');
    if (user.role !== 'PATIENT' && !user.mfaCredential?.enabledAt) {
      const setupToken = app.jwt.sign({ sub: user.id, role: user.role, mfaSetup: true }, { expiresIn: '5m' });
      return reply.send({ data: { accessToken: setupToken, tokenType: 'Bearer', expiresIn: 300, mfaEnrollmentRequired: true }, requestId: req.id });
    }
    if (user.role !== 'PATIENT' && (!body.totp || !verifyTotp(decryptMfaSecret(user.mfaCredential!.secretEncrypted), body.totp))) throw new AppError(401, 'A valid MFA code is required', 'MFA_INVALID');
    return reply.send({ data: await issueSession(user.id, user.role), requestId: req.id });
  });

  app.post('/refresh', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { refreshToken } = z.object({ refreshToken: z.string().min(40).max(200) }).parse(req.body);
    const old = await prisma.refreshToken.findUnique({ where: { tokenHash: sha(refreshToken) }, include: { user: { include: { mfaCredential: true } } } });
    if (!old) throw new AppError(401, 'Invalid refresh token', 'INVALID_REFRESH_TOKEN');
    if (old.revokedAt || old.expiresAt < new Date()) {
      if (old.revokedAt) await prisma.refreshToken.updateMany({ where: { familyId: old.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
      throw new AppError(401, 'Refresh token expired or reused', 'REFRESH_TOKEN_REVOKED');
    }
    if (old.user.status !== 'ACTIVE' || (old.user.role !== 'PATIENT' && !old.user.mfaCredential?.enabledAt)) throw new AppError(401, 'Account session is no longer valid', 'SESSION_REVOKED');
    const rawNext = randomBytes(48).toString('base64url');
    const now = new Date();
    const next = await prisma.$transaction(async tx => {
      const claimed = await tx.refreshToken.updateMany({ where: { id: old.id, revokedAt: null, expiresAt: { gt: now } }, data: { revokedAt: now } });
      if (claimed.count !== 1) return null;
      const replacement = await tx.refreshToken.create({ data: { tokenHash: sha(rawNext), familyId: old.familyId, userId: old.userId, expiresAt: new Date(Date.now() + 30 * 86400000) } });
      await tx.refreshToken.update({ where: { id: old.id }, data: { replacedById: replacement.id } });
      return replacement;
    });
    if (!next) {
      await prisma.refreshToken.updateMany({ where: { familyId: old.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
      throw new AppError(401, 'Refresh token has already been used', 'REFRESH_TOKEN_REUSED');
    }
    return reply.send({ data: { accessToken: app.jwt.sign({ sub: old.user.id, role: old.user.role, mfa: true }), refreshToken: rawNext, tokenType: 'Bearer', expiresIn: 600 }, requestId: req.id });
  });

  app.post('/logout', async (req, reply) => {
    const { refreshToken } = z.object({ refreshToken: z.string().min(40).max(200) }).parse(req.body);
    await prisma.refreshToken.updateMany({ where: { tokenHash: sha(refreshToken), revokedAt: null }, data: { revokedAt: new Date() } });
    return reply.code(204).send();
  });

  app.post('/password-reset/request', { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } }, async (req, reply) => {
    const { email } = z.object({ email: z.string().email().transform(v => v.toLowerCase()) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true, status: true } });
    let developmentToken: string | undefined;
    if (user?.status === 'ACTIVE') {
      const raw = randomBytes(32).toString('base64url');
      await prisma.passwordResetToken.create({ data: { tokenHash: sha(raw), userId: user.id, expiresAt: new Date(Date.now() + 30 * 60 * 1000) } });
      if (process.env.NODE_ENV !== 'production') developmentToken = raw;
    }
    return reply.send({ data: { accepted: true, ...(developmentToken ? { developmentToken } : {}) }, requestId: req.id });
  });
  app.post('/password-reset/complete', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req, reply) => {
    const { token, password } = z.object({ token: z.string().min(32).max(200), password: z.string().min(12).max(128) }).parse(req.body);
    const found = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha(token) } });
    const now = new Date();
    if (!found || found.usedAt || found.expiresAt <= now) throw new AppError(400, 'Reset token is invalid or expired', 'INVALID_RESET_TOKEN');
    const passwordHash = await hashPassword(password);
    await prisma.$transaction(async tx => {
      const claimed = await tx.passwordResetToken.updateMany({ where: { id: found.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
      if (claimed.count !== 1) throw new AppError(400, 'Reset token is invalid or expired', 'INVALID_RESET_TOKEN');
      await tx.user.update({ where: { id: found.userId }, data: { passwordHash } });
      await tx.refreshToken.updateMany({ where: { userId: found.userId, revokedAt: null }, data: { revokedAt: now } });
      await tx.auditLog.create({ data: { actorId: found.userId, action: 'user.password_reset', resourceType: 'user', resourceId: found.userId, correlationId: req.id } });
    });
    return reply.send({ data: { reset: true }, requestId: req.id });
  });

  app.post('/mfa/enroll', async (req, reply) => {
    const actor = await req.jwtVerify<{ sub: string; role: 'PATIENT'|'DOCTOR'|'ADMIN'; mfaSetup?: boolean }>();
    if (!actor.mfaSetup || actor.role === 'PATIENT') throw new AppError(403, 'MFA enrollment is available only during privileged account setup', 'FORBIDDEN');
    const secret = createTotpSecret();
    await prisma.mfaCredential.upsert({ where: { userId: actor.sub }, create: { userId: actor.sub, secretEncrypted: encryptMfaSecret(secret) }, update: { secretEncrypted: encryptMfaSecret(secret), enabledAt: null } });
    const label = encodeURIComponent(`Amrutam:${actor.sub}`);
    const issuer = encodeURIComponent('Amrutam');
    return reply.send({ data: { secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30` }, requestId: req.id });
  });
  app.post('/mfa/verify', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const actor = await req.jwtVerify<{ sub: string; role: 'PATIENT'|'DOCTOR'|'ADMIN'; mfaSetup?: boolean }>();
    if (!actor.mfaSetup || actor.role === 'PATIENT') throw new AppError(403, 'MFA setup token required', 'FORBIDDEN');
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/u) }).parse(req.body);
    const credential = await prisma.mfaCredential.findUnique({ where: { userId: actor.sub } });
    if (!credential || !verifyTotp(decryptMfaSecret(credential.secretEncrypted), code)) throw new AppError(401, 'Invalid MFA code', 'MFA_INVALID');
    await prisma.mfaCredential.update({ where: { userId: actor.sub }, data: { enabledAt: new Date() } });
    await prisma.auditLog.create({ data: { actorId: actor.sub, action: 'user.mfa_enabled', resourceType: 'user', resourceId: actor.sub, correlationId: req.id } });
    return reply.send({ data: await issueSession(actor.sub, actor.role), requestId: req.id });
  });
}
