import { FastifyRequest } from 'fastify';
import { AppError } from './errors';

export type AuthenticatedUser = { sub: string; role: 'PATIENT'|'DOCTOR'|'ADMIN'; mfa?: boolean; mfaSetup?: boolean };

export async function authenticate(request: FastifyRequest): Promise<AuthenticatedUser> {
  const user = await request.jwtVerify<AuthenticatedUser>();
  if (user.mfaSetup || (user.role !== 'PATIENT' && user.mfa !== true)) throw new AppError(403, 'Privileged accounts must complete MFA', 'MFA_REQUIRED');
  return user;
}
