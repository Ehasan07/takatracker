import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { loginSchema, signupSchema } from '@hishab/shared';
import { zodPipe } from '../common/zod.pipe';
import { AccountService } from './account.service';
import { AuthService, type AuthResult } from './auth.service';
import { CurrentUser, type AuthUser } from './current-user.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';
import { NoImpersonationGuard } from './no-impersonation.guard';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './jwt.strategy';
import { SessionsService, type SessionRequestContext } from './sessions.service';

const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

/** Auth endpoints are rate-limited; the e2e suite needs headroom to sign up users. */
const rate = (limit: number) => ({ default: { limit: isTest ? 10_000 : limit, ttl: 60_000 } });

/** Links arrive as an opaque base64url string; bound so a body cannot be huge. */
const tokenField = z.string().min(1).max(512);

const verifyConfirmSchema = z.object({ token: tokenField });
const forgotPasswordSchema = z.object({ email: z.string().email() });

const signInCodeRequestSchema = z
  .object({
    /* An email or a Bangladeshi mobile, the same box the login form uses. */
    identifier: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().min(1).max(200).optional(),
    /* Email unless asked otherwise. SMS costs money and lands on a lock
       screen, so it is never the default. */
    channel: z.enum(['email', 'sms']).default('email'),
  })
  .transform((value) => ({
    identifier: value.identifier ?? value.email ?? '',
    channel: value.channel,
  }))
  .refine((value) => value.identifier !== '', {
    message: 'ইমেইল বা মোবাইল নম্বর দিন',
    path: ['identifier'],
  });

const signInCodeVerifySchema = z.object({
  identifier: z.string().trim().min(1).max(200),
  /* Digits only, exactly six. Trimmed and stripped first, because a code
     pasted out of a mail client arrives with whitespace attached. */
  code: z
    .string()
    .transform((value) => value.replace(/\D/g, ''))
    .pipe(z.string().length(6)),
});
const resetPasswordSchema = z.object({
  token: tokenField,
  password: z.string().min(8, 'কমপক্ষে ৮ অক্ষর').max(200),
});
/** `currentPassword` is only ever compared, never stored, so it is not bounded by policy. */
/* Digits only, and generous about the shape. People paste "042 931" out of the
 * email and type dashes; the service strips everything that is not a digit, so
 * the schema only has to keep the field a short string. */
const verifyCodeSchema = z.object({ code: z.string().min(4).max(16) });

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8, 'কমপক্ষে ৮ অক্ষর').max(200),
});
/** Mobile has no cookie jar, so it may name its own session in the body. */
const revokeOthersSchema = z.object({ refreshToken: z.string().min(1).optional() }).default({});

type CookieRequest = Request & { cookies?: Record<string, string> };

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly account: AccountService,
    private readonly sessions: SessionsService,
  ) {}

  /** How a request identifies which session it is speaking from. */
  private sessionContext(req: CookieRequest, refreshToken?: string): SessionRequestContext {
    return {
      refreshToken: refreshToken ?? req.cookies?.[REFRESH_COOKIE],
      deviceId: req.header('x-device-id') ?? undefined,
      ip: req.ip,
      userAgent: req.header('user-agent') ?? undefined,
    };
  }

  private clearCookies(res: Response): void {
    res.clearCookie(ACCESS_COOKIE, { path: '/' });
    res.clearCookie(REFRESH_COOKIE, { path: '/' });
  }

  private static readonly cookieOptions = {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax' as const,
    path: '/',
  };

  /** The short-lived half on its own, for a session that outlives its access token. */
  private setAccessCookie(res: Response, accessToken: string): void {
    res.cookie(ACCESS_COOKIE, accessToken, {
      ...AuthController.cookieOptions,
      maxAge: 15 * 60 * 1000,
    });
  }

  /** Same-origin httpOnly cookies for the web app; the body serves mobile. */
  private setCookies(res: Response, result: AuthResult): void {
    this.setAccessCookie(res, result.accessToken);
    res.cookie(REFRESH_COOKIE, result.refreshToken, {
      ...AuthController.cookieOptions,
      maxAge: 30 * 86_400 * 1000,
    });
  }

  @Post('signup')
  @Throttle(rate(5))
  async signup(
    @Body(zodPipe(signupSchema)) body: ReturnType<typeof signupSchema.parse>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.signup(body, {
      ip: req.ip,
      userAgent: req.header('user-agent') ?? undefined,
    });
    this.setCookies(res, result);
    return result;
  }

  @Post('login')
  @HttpCode(200)
  @Throttle(rate(10))
  async login(
    @Body(zodPipe(loginSchema)) body: ReturnType<typeof loginSchema.parse>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(body, {
      deviceId: req.header('x-device-id') ?? undefined,
      userAgent: req.header('user-agent') ?? undefined,
      ip: req.ip,
    });
    this.setCookies(res, result);
    return result;
  }

  @Post('refresh')
  @HttpCode(200)
  @Throttle(rate(30))
  async refresh(
    @Req() req: Request & { cookies?: Record<string, string> },
    @Body() body: { refreshToken?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = body?.refreshToken ?? req.cookies?.[REFRESH_COOKIE];
    if (!token) throw new UnauthorizedException('রিফ্রেশ টোকেন নেই');
    const result = await this.auth.refresh(
      token,
      req.header('x-device-id') ?? undefined,
      req.header('user-agent') ?? undefined,
    );
    this.setCookies(res, result);
    return result;
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() req: Request & { cookies?: Record<string, string> },
    @Body() body: { refreshToken?: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(body?.refreshToken ?? req.cookies?.[REFRESH_COOKIE]);
    this.clearCookies(res);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: AuthUser) {
    const [profile, onboardingCompletedAt] = await Promise.all([
      this.auth.me(user.id, user.workspaceId),
      this.account.onboardingCompletedAt(user.workspaceId),
    ]);
    // `emailVerifiedAt` (from the profile) drives the verification nag and
    // `onboardingCompletedAt` the first-run flow. Both are additive fields.
    return {
      ...profile,
      onboardingCompletedAt: onboardingCompletedAt?.toISOString() ?? null,
      /* Read off the token, so a support banner survives a reload that lost the
       * start response. `false` on every ordinary session, which is every
       * session but a handful. */
      isImpersonated: user.impersonatedBy !== null,
    };
  }

  // --- email verification ----------------------------------------------------

  @Post('verify/send')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @Throttle(rate(5))
  sendVerification(@CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.account.sendVerification(user.id, user.workspaceId, {
      ip: req.ip,
      userAgent: req.header('user-agent') ?? undefined,
    });
  }

  /**
   * Anonymous: the link is routinely opened on a different device from the one
   * that asked for it, and requiring a session there would strand people.
   */
  @Post('verify/confirm')
  @HttpCode(200)
  @Throttle(rate(20))
  confirmVerification(
    @Body(zodPipe(verifyConfirmSchema)) body: z.infer<typeof verifyConfirmSchema>,
    @Req() req: Request,
  ) {
    return this.account.confirmVerification(body.token, {
      ip: req.ip,
      userAgent: req.header('user-agent') ?? undefined,
    });
  }

  /**
   * `POST /v1/auth/verify/code` — the six digits from the email.
   *
   * Session-authenticated, unlike the link. A code is typed by somebody already
   * looking at the app, so there is no cross-device case to serve — and
   * requiring the session means an attacker needs the account as well as the
   * digits, rather than the digits alone.
   *
   * Throttled harder than the link path, and the per-token attempt cap in
   * `EmailTokenService.checkCode` is the other half: the throttle bounds the
   * rate, the cap bounds the total, and six digits needs both.
   */
  @Post('verify/code')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @Throttle(rate(10))
  confirmVerificationCode(
    @CurrentUser() user: AuthUser,
    @Body(zodPipe(verifyCodeSchema)) body: z.infer<typeof verifyCodeSchema>,
    @Req() req: Request,
  ) {
    return this.account.confirmVerificationCode(user.id, body.code, {
      ip: req.ip,
      userAgent: req.header('user-agent') ?? undefined,
    });
  }

  // --- password reset --------------------------------------------------------

  /**
   * Always 200, always the same body, whether or not the address is registered.
   * This is an account-enumeration defence, not an oversight — see
   * `FORGOT_RESPONSE` in account.service.ts before changing anything here.
   */
  @Post('password/forgot')
  @HttpCode(200)
  @Throttle(rate(5))
  forgotPassword(
    @Body(zodPipe(forgotPasswordSchema)) body: z.infer<typeof forgotPasswordSchema>,
    @Req() req: Request,
  ) {
    return this.account.forgotPassword(body.email, {
      ip: req.ip,
      userAgent: req.header('user-agent') ?? undefined,
    });
  }

  /**
   * Ask for a sign-in code. Always 200, always the same body.
   *
   * The same account-enumeration defence as `password/forgot`, and for a route
   * that matters more: this one hands out a way *in* rather than a way to
   * change the password. See `requestSignInCode`.
   *
   * Throttled harder than login. A wrong password costs an attacker nothing but
   * a request; this sends a real email to a real person every time it succeeds,
   * so the rate limit is protecting the account holder's inbox as much as the
   * server.
   */
  @Post('otp/request')
  @HttpCode(200)
  @Throttle(rate(3))
  async requestSignInCode(
    @Body(zodPipe(signInCodeRequestSchema)) body: z.infer<typeof signInCodeRequestSchema>,
    @Req() req: Request,
  ) {
    await this.auth.requestSignInCode(body.identifier, {
      ip: req.ip,
      userAgent: req.header('user-agent') ?? undefined,
      channel: body.channel === 'sms' ? 'SMS' : 'EMAIL',
    });
    /* One sentence for both channels and for an identifier with no account.
       Naming the channel back would say whether the account has a phone. */
    return { message: 'অ্যাকাউন্ট থাকলে একটি কোড পাঠানো হয়েছে।' };
  }

  /** Trade the code for a session. Audited as `auth.signin_code`, not `auth.login`. */
  @Post('otp/verify')
  @HttpCode(200)
  @Throttle(rate(10))
  async verifySignInCode(
    @Body(zodPipe(signInCodeVerifySchema)) body: z.infer<typeof signInCodeVerifySchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.signInWithCode(body.identifier, body.code, {
      deviceId: req.header('x-device-id') ?? undefined,
      userAgent: req.header('user-agent') ?? undefined,
      ip: req.ip,
    });
    this.setCookies(res, result);
    return result;
  }

  @Post('password/reset')
  @HttpCode(200)
  @Throttle(rate(10))
  async resetPassword(
    @Body(zodPipe(resetPasswordSchema)) body: z.infer<typeof resetPasswordSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.account.resetPassword(body.token, body.password, {
      ip: req.ip,
      userAgent: req.header('user-agent') ?? undefined,
    });
    // Every session on the account was just destroyed, this browser's included.
    // Leaving a stale access-token cookie behind only produces confusing 401s.
    this.clearCookies(res);
    return result;
  }

  /**
   * Change the password of a signed-in user. Not a reset: see
   * `AccountService.changePassword` for why this one keeps the caller logged in.
   */
  @Post('password/change')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, NoImpersonationGuard)
  @Throttle(rate(5))
  async changePassword(
    @Body(zodPipe(changePasswordSchema)) body: z.infer<typeof changePasswordSchema>,
    @CurrentUser() user: AuthUser,
    @Req() req: CookieRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.account.changePassword(
      user.id,
      user.workspaceId,
      body.currentPassword,
      body.newPassword,
      this.sessionContext(req),
    );

    if (result.currentSessionRevoked) {
      // The caller's own family went with the rest, so leaving cookies behind
      // only produces confusing 401s. Same handling as password/reset.
      this.clearCookies(res);
      return result;
    }

    /* The `tokenVersion` bump inside changePassword invalidated the access
     * token that authorised this very request — this browser's cookie included.
     * The refresh family was kept alive on purpose, so replace only the
     * short-lived half and the session carries on without a visible blip. The
     * body carries it too, for mobile, which has no cookie jar. */
    const { accessToken, expiresIn } = await this.auth.reissueAccessToken(
      user.id,
      user.workspaceId,
    );
    this.setAccessCookie(res, accessToken);
    return { ...result, accessToken, expiresIn };
  }

  // --- sessions --------------------------------------------------------------

  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  async listSessions(@CurrentUser() user: AuthUser, @Req() req: CookieRequest) {
    return { sessions: await this.sessions.list(user.id, this.sessionContext(req)) };
  }

  @Delete('sessions/:familyId')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, NoImpersonationGuard)
  async revokeSession(
    @CurrentUser() user: AuthUser,
    @Param('familyId') familyId: string,
    @Req() req: CookieRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.sessions.revoke(user.id, familyId, this.sessionContext(req));
    if (result.wasCurrent) this.clearCookies(res);
    return result;
  }

  @Post('sessions/revoke-others')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, NoImpersonationGuard)
  async revokeOtherSessions(
    @Body(zodPipe(revokeOthersSchema)) body: z.infer<typeof revokeOthersSchema>,
    @CurrentUser() user: AuthUser,
    @Req() req: CookieRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.sessions.revokeOthers(
      user.id,
      this.sessionContext(req, body.refreshToken),
    );
    if (result.currentSessionRevoked) this.clearCookies(res);
    return result;
  }

  // --- onboarding ------------------------------------------------------------

  @Post('onboarding/complete')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  completeOnboarding(@CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.account.completeOnboarding(user.workspaceId, user.id, {
      ip: req.ip,
      userAgent: req.header('user-agent') ?? undefined,
    });
  }
}
