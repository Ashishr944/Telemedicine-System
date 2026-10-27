import argon2 from 'argon2';
import { prisma } from '../src/plugins/prisma';

async function main() {
  if (process.env.NODE_ENV !== 'development') throw new Error('Demo seed is restricted to NODE_ENV=development');
  const demoPassword = 'LocalDemoOnly!2026';
  const passwordHash = await argon2.hash(demoPassword, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  const patient = await prisma.user.upsert({ where: { email: 'patient.demo@example.test' }, update: {}, create: { email: 'patient.demo@example.test', passwordHash, role: 'PATIENT', patient: { create: { fullName: 'Demo Patient' } } } });
  const doctor = await prisma.user.upsert({ where: { email: 'doctor.demo@example.test' }, update: {}, create: { email: 'doctor.demo@example.test', passwordHash, role: 'DOCTOR', doctor: { create: { fullName: 'Dr Demo', feeMinor: 80000, verified: true, bio: 'Local demonstration profile' } } } });
  const specialty = await prisma.specialty.upsert({ where: { name: 'General Medicine' }, update: {}, create: { name: 'General Medicine' } });
  await prisma.doctorSpecialty.upsert({ where: { doctorId_specialtyId: { doctorId: doctor.id, specialtyId: specialty.id } }, update: {}, create: { doctorId: doctor.id, specialtyId: specialty.id } });
  const start = new Date(); start.setUTCDate(start.getUTCDate() + 1); start.setUTCHours(10, 0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  await prisma.availabilitySlot.upsert({ where: { doctorId_startsAt: { doctorId: doctor.id, startsAt: start } }, update: {}, create: { doctorId: doctor.id, startsAt: start, endsAt: end, timeZone: 'Asia/Kolkata' } });
  console.log('Local demo records ready. Both accounts use LocalDemoOnly!2026; never use this seed outside local development.');
  void patient;
}

main().finally(async () => { await prisma.$disconnect(); });
