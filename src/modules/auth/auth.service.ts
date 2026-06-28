import bcrypt from 'bcryptjs';
import { prisma } from '../../lib/prisma';
import { generateOtpCode, getOtpExpiry, sendOtp } from '../../lib/otp';
import { signToken } from '../../lib/jwt';
import { config } from '../../config';

const STAFF_ROLES = ['SUPER_ADMIN', 'PICKER', 'DRIVER'] as const;

export async function requestOtp(mobile: string): Promise<{ code?: string }> {
  let user = await prisma.user.findUnique({ where: { mobile } });

  if (!user) {
    user = await prisma.user.create({ data: { mobile } });
  } else if (user.role !== 'CUSTOMER') {
    // Staff accounts must use the staff login (email + password), not OTP.
    throw new Error('This number is registered as a staff account. Use staff login.');
  }

  if (!user.isActive) throw new Error('Account is deactivated');

  // Invalidate previous unused OTPs
  await prisma.otpCode.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  const code = generateOtpCode();
  const expiresAt = getOtpExpiry();

  await prisma.otpCode.create({
    data: { userId: user.id, code, expiresAt },
  });

  await sendOtp(mobile, code);

  // Return the code so the marketplace can show the MVP login badge. Gated by
  // `otp.exposeCode` (default ON) — also always on in dev. Turn off via
  // OTP_EXPOSE_CODE=false once a real SMS gateway is in place.
  return config.isDev || config.otp.exposeCode ? { code } : {};
}

export async function verifyOtp(
  mobile: string,
  code: string
): Promise<{ token: string; user: object }> {
  const user = await prisma.user.findUnique({ where: { mobile } });
  if (!user) throw new Error('User not found');
  if (user.role !== 'CUSTOMER') {
    throw new Error('Staff accounts must use the staff login.');
  }
  if (!user.isActive) throw new Error('Account is deactivated');

  const otp = await prisma.otpCode.findFirst({
    where: {
      userId: user.id,
      code,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!otp) throw new Error('Invalid or expired OTP');

  await prisma.otpCode.update({
    where: { id: otp.id },
    data: { usedAt: new Date() },
  });

  const token = signToken({ userId: user.id, role: user.role, scope: 'customer' });

  return {
    token,
    user: {
      id: user.id,
      mobile: user.mobile,
      name: user.name,
      role: user.role,
    },
  };
}

export async function staffLogin(
  email: string,
  password: string
): Promise<{ token: string; user: object }> {
  const normalisedEmail = email.toLowerCase().trim();
  const user = await prisma.user.findUnique({ where: { email: normalisedEmail } });

  // Generic error so we do not leak whether the email exists.
  const invalid = new Error('Invalid email or password');

  if (!user || !user.passwordHash) throw invalid;
  if (!STAFF_ROLES.includes(user.role as (typeof STAFF_ROLES)[number])) {
    // Customers must use the OTP flow.
    throw invalid;
  }
  if (!user.isActive) throw new Error('Account is deactivated');

  const matches = await bcrypt.compare(password, user.passwordHash);
  if (!matches) throw invalid;

  const token = signToken({ userId: user.id, role: user.role, scope: 'staff' });

  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      name: user.name,
      role: user.role,
    },
  };
}

export async function getMe(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      mobile: true,
      email: true,
      username: true,
      name: true,
      nameAr: true,
      role: true,
      isActive: true,
      createdAt: true,
      subscription: {
        select: {
          id: true,
          status: true,
          expiryDate: true,
          plan: { select: { name: true, benefitType: true } },
        },
      },
    },
  });
  if (!user) throw new Error('User not found');
  return user;
}
