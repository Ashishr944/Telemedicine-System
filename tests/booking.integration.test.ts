import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { generateTotpCode } from '../src/common/mfa';

const enabled = process.env.RUN_DB_INTEGRATION === '1';
describe.skipIf(!enabled)('PostgreSQL booking concurrency', () => {
  let app: FastifyInstance;
  let prisma: typeof import('../src/plugins/prisma').prisma;
  let doctorId: string;
  let token: string;
  let secondPatientToken: string;
  let patientEmail: string;
  let doctorEmail: string;
  const doctorPassword = 'IntegrationDoctor!Password23';
  let slotSequence = 0;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_URL ??= 'postgresql://postgres@127.0.0.1:55432/amrutam?schema=public';
    process.env.JWT_SECRET ??= 'integration-test-secret-with-at-least-32-chars';
    const [{ buildApp }, db] = await Promise.all([import('../src/app'), import('../src/plugins/prisma')]);
    app = await buildApp({ logger: false });
    prisma = db.prisma;
    const stamp = randomUUID();
    patientEmail = `patient-${stamp}@example.test`;
    doctorEmail = `doctor-${stamp}@example.test`;
    const patient = await prisma.user.create({ data: { email: patientEmail, passwordHash: 'not-used', role: 'PATIENT', patient: { create: { fullName: 'Integration Patient' } } } });
    const otherPatient = await prisma.user.create({ data: { email: `other-patient-${stamp}@example.test`, passwordHash: 'not-used', role: 'PATIENT', patient: { create: { fullName: 'Other Integration Patient' } } } });
    const doctor = await prisma.user.create({ data: { email: doctorEmail, passwordHash: await argon2.hash(doctorPassword), role: 'DOCTOR', doctor: { create: { fullName: 'Integration Doctor', feeMinor: 80000, verified: true } } } });
    doctorId = doctor.id;
    token = app.jwt.sign({ sub: patient.id, role: 'PATIENT' });
    secondPatientToken = app.jwt.sign({ sub: otherPatient.id, role: 'PATIENT' });
  });

  afterAll(async () => { await app.close(); await prisma.$disconnect(); });

  async function slot() {
    slotSequence += 1;
    const startsAt = new Date(Date.now() + (48 + slotSequence * 2) * 60 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 30 * 60 * 1000);
    return prisma.availabilitySlot.create({ data: { doctorId, startsAt, endsAt, timeZone: 'Asia/Kolkata' } });
  }

  it('allows only one of two concurrent patients to reserve a slot', async () => {
    const available = await slot();
    const send = (key: string, accessToken: string) => app.inject({ method: 'POST', url: '/api/v1/consultations', headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': key }, payload: { slotId: available.id } });
    const results = await Promise.all([send(randomUUID(), token), send(randomUUID(), secondPatientToken)]);
    expect(results.map(r => r.statusCode).sort()).toEqual([201, 409]);
    expect(await prisma.consultation.count({ where: { slotId: available.id } })).toBe(1);
  });

  it('replays a committed response for the same idempotency key', async () => {
    const available = await slot();
    const key = randomUUID();
    const send = () => app.inject({ method: 'POST', url: '/api/v1/consultations', headers: { authorization: `Bearer ${token}`, 'idempotency-key': key }, payload: { slotId: available.id } });
    const first = await send();
    const replay = await send();
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json().data.id).toBe(first.json().data.id);
  });

  it('rejects the same idempotency key with a changed payload', async () => {
    const firstSlot = await slot();
    const differentSlot = await slot();
    const key = randomUUID();
    const send = (slotId: string) => app.inject({ method: 'POST', url: '/api/v1/consultations', headers: { authorization: `Bearer ${token}`, 'idempotency-key': key }, payload: { slotId } });
    expect((await send(firstSlot.id)).statusCode).toBe(201);
    const mismatch = await send(differentSlot.id);
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('enforces MFA enrollment and verification for doctors', async () => {
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: doctorEmail, password: doctorPassword } });
    expect(login.statusCode).toBe(200);
    expect(login.json().data.mfaEnrollmentRequired).toBe(true);
    const setupToken = login.json().data.accessToken as string;
    const headers = { authorization: `Bearer ${setupToken}` };
    const enrollment = await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/enroll', headers });
    const secret = enrollment.json().data.secret as string;
    const blocked = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers });
    expect(blocked.statusCode).toBe(403);
    const code = generateTotpCode(secret);
    const verified = await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/verify', headers, payload: { code } });
    expect(verified.statusCode).toBe(200);
    const accessToken = verified.json().data.accessToken as string;
    const profile = await app.inject({ method: 'GET', url: '/api/v1/users/me', headers: { authorization: `Bearer ${accessToken}` } });
    expect(profile.statusCode).toBe(200);
    const secondLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: doctorEmail, password: doctorPassword, totp: generateTotpCode(secret) } });
    expect(secondLogin.statusCode).toBe(200);
    expect(secondLogin.json().data.mfaEnrollmentRequired).toBeUndefined();
  });

  it('makes password reset tokens expiring and single-use', async () => {
    const requested = await app.inject({ method: 'POST', url: '/api/v1/auth/password-reset/request', payload: { email: patientEmail } });
    const resetToken = requested.json().data.developmentToken as string;
    const completed = await app.inject({ method: 'POST', url: '/api/v1/auth/password-reset/complete', payload: { token: resetToken, password: 'NewIntegrationPass!234' } });
    expect(completed.statusCode).toBe(200);
    const replay = await app.inject({ method: 'POST', url: '/api/v1/auth/password-reset/complete', payload: { token: resetToken, password: 'OtherIntegrationPass!234' } });
    expect(replay.statusCode).toBe(400);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: patientEmail, password: 'NewIntegrationPass!234' } });
    expect(login.statusCode).toBe(200);

    const secondRequest = await app.inject({ method: 'POST', url: '/api/v1/auth/password-reset/request', payload: { email: patientEmail } });
    const expiredToken = secondRequest.json().data.developmentToken as string;
    const hash = createHash('sha256').update(expiredToken).digest('hex');
    await prisma.passwordResetToken.update({ where: { tokenHash: hash }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await app.inject({ method: 'POST', url: '/api/v1/auth/password-reset/complete', payload: { token: expiredToken, password: 'ExpiredIntegrationPass!23' } });
    expect(expired.statusCode).toBe(400);
  });
});
