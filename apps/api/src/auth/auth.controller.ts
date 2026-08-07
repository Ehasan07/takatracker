import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { loginSchema, signupSchema } from '@hishab/shared';
import { zodPipe } from '../common/zod.pipe';
import { AuthService, type AuthResult } from './auth.service';
import { CurrentUser, type AuthUser } from './current-user.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './jwt.strategy';

const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

/** Auth endpoints are rate-limited; the e2e suite needs headroom to sign up users. */
const rate = (limit: number) => ({ default: { limit: isTest ? 10_000 : limit, ttl: 60_000 } });

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Same-origin httpOnly cookies for the web app; the body serves mobile. */
  private setCookies(res: Response, result: AuthResult): void {
    const common = { httpOnly: true, secure: isProd, sameSite: 'lax' as const, path: '/' };
    res.cookie(ACCESS_COOKIE, result.accessToken, { ...common, maxAge: 15 * 60 * 1000 });
    res.cookie(REFRESH_COOKIE, result.refreshToken, {
      ...common,
      maxAge: 30 * 86_400 * 1000,
    });
  }

  @Post('signup')
  @Throttle(rate(5))
  async signup(
    @Body(zodPipe(signupSchema)) body: ReturnType<typeof signupSchema.parse>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.signup(body);
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
    const result = await this.auth.login(
      body,
      req.header('x-device-id') ?? undefined,
      req.header('user-agent') ?? undefined,
    );
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
    res.clearCookie(ACCESS_COOKIE, { path: '/' });
    res.clearCookie(REFRESH_COOKIE, { path: '/' });
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id, user.workspaceId);
  }
}
