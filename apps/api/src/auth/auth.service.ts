import { randomBytes, createHash } from 'node:crypto';
import { ConflictException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { DEFAULT_CATEGORIES, SYSTEM_ACCOUNT_SEED } from '@hishab/core';
import type { LoginInput, SignupInput } from '@hishab/shared';
import { PrismaService } from '../prisma/prisma.service';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface AuthResult extends TokenPair {
  user: { id: string; email: string; name: string; locale: string; timezone: string };
}

const REFRESH_TTL_DAYS = 30;
const ACCESS_TTL = process.env.JWT_ACCESS_TTL ?? '15m';

/** Argon2id parameters — OWASP's second recommended option (19 MiB, t=2, p=1). */
const ARGON_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  private static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async signup(input: SignupInput): Promise<AuthResult> {
    const email = input.email.toLowerCase().trim();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException('এই ইমেইলে ইতিমধ্যে অ্যাকাউন্ট আছে');

    const passwordHash = await argon2.hash(input.password, ARGON_OPTIONS);

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          name: input.name,
          phone: input.phone,
          passwordHash,
          locale: input.locale,
          timezone: input.timezone,
        },
      });

      // Hidden nominal accounts that make the double entry balance.
      await tx.account.createMany({
        data: SYSTEM_ACCOUNT_SEED.map((a, i) => ({
          userId: created.id,
          name: a.name,
          type: a.type,
          systemKey: a.systemKey,
          sortOrder: 1000 + i,
        })),
      });

      // Bangladesh-appropriate default category tree.
      await tx.category.createMany({
        data: DEFAULT_CATEGORIES.map((c) => ({
          userId: created.id,
          name: c.name,
          nameBn: c.nameBn,
          kind: c.kind,
          icon: c.icon,
          sortOrder: c.sortOrder,
          isSystem: true,
        })),
      });

      return created;
    });

    this.logger.log(`New user ${user.id}`);
    return this.issue(user.id, user.email, user.name, user.locale, user.timezone);
  }

  async login(input: LoginInput, deviceId?: string, userAgent?: string): Promise<AuthResult> {
    const email = input.email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({ where: { email } });

    // Constant-ish work whether or not the user exists, so timing says nothing.
    const hash = user?.passwordHash ?? (await AuthService.dummyHash());
    const ok = await argon2.verify(hash, input.password).catch(() => false);

    if (!user || !ok) throw new UnauthorizedException('ইমেইল বা পাসওয়ার্ড ভুল');

    return this.issue(user.id, user.email, user.name, user.locale, user.timezone, {
      deviceId,
      userAgent,
    });
  }

  private static dummyHashCache: string | null = null;
  private static async dummyHash(): Promise<string> {
    AuthService.dummyHashCache ??= await argon2.hash('not-a-real-password', ARGON_OPTIONS);
    return AuthService.dummyHashCache;
  }

  private async issue(
    userId: string,
    email: string,
    name: string,
    locale: string,
    timezone: string,
    meta: { deviceId?: string; userAgent?: string; familyId?: string } = {},
  ): Promise<AuthResult> {
    const accessToken = await this.jwt.signAsync(
      { sub: userId, email },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: ACCESS_TTL },
    );

    const refreshToken = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000);

    await this.prisma.refreshToken.create({
      data: {
        userId,
        familyId: meta.familyId ?? randomBytes(16).toString('hex'),
        tokenHash: AuthService.hashToken(refreshToken),
        deviceId: meta.deviceId,
        userAgent: meta.userAgent?.slice(0, 300),
        expiresAt,
      },
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: 15 * 60,
      user: { id: userId, email, name, locale, timezone },
    };
  }

  /**
   * Rotate a refresh token. Replaying an already-used token revokes the whole
   * family — the classic stolen-token defence (spec §9).
   */
  async refresh(token: string, deviceId?: string, userAgent?: string): Promise<AuthResult> {
    const tokenHash = AuthService.hashToken(token);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored) throw new UnauthorizedException('সেশন মেয়াদোত্তীর্ণ');

    if (stored.usedAt || stored.revokedAt) {
      await this.prisma.refreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      this.logger.warn(`Refresh token reuse detected for user ${stored.userId}; family revoked`);
      throw new UnauthorizedException('সেশন বাতিল করা হয়েছে, আবার লগইন করুন');
    }

    if (stored.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('সেশন মেয়াদোত্তীর্ণ');
    }

    const next = await this.issue(
      stored.userId,
      stored.user.email,
      stored.user.name,
      stored.user.locale,
      stored.user.timezone,
      { deviceId, userAgent, familyId: stored.familyId },
    );

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { usedAt: new Date(), replacedBy: AuthService.hashToken(next.refreshToken) },
    });

    return next;
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: AuthService.hashToken(token) },
    });
    if (!stored) return;
    await this.prisma.refreshToken.updateMany({
      where: { familyId: stored.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        locale: true,
        baseCurrency: true,
        timezone: true,
        createdAt: true,
      },
    });
    return user;
  }
}
