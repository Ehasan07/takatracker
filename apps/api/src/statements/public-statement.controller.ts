import { Controller, Get, Header, NotFoundException, Param, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { StatementShareService } from './statement-share.service';
import { PublicStatementService } from './public-statement.service';

/**
 * The one route in this API with no `JwtAuthGuard` on it.
 *
 * Everything else here is behind a token that proves who is asking and which
 * workspace they may read. This one is opened by a person who has no account
 * and should not need one — a relative you lent money to, an insurer you pay a
 * premium to — so the link itself is the credential.
 *
 * That places the whole weight on three things, and they are all in
 * `StatementShareService`: the token is thirty-two random bytes stored only as
 * a hash, the row carries its own date window so the URL cannot be edited to
 * widen it, and it expires.
 *
 * ## Why every failure looks the same
 *
 * Unknown token, revoked link, expired link — one 404, one sentence. Telling a
 * stranger "this link existed but has expired" confirms that somebody's
 * statement was shared, which is not theirs to learn. The same reasoning as the
 * password-reset and sign-in-code routes.
 *
 * ## Why it is throttled harder than anything else
 *
 * A guessed token would return somebody's ledger. Thirty-two bytes is not
 * guessable at any rate, but a route that hands out financial records to
 * unauthenticated callers should not also be a free query engine.
 */
@Controller('public/statement')
export class PublicStatementController {
  constructor(
    private readonly shares: StatementShareService,
    private readonly statements: PublicStatementService,
  ) {}

  @Get(':token')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  /* Belt and braces with the page's own `<meta name="robots">`: a link pasted
     into a public thread must not end up in a search result, and a crawler that
     ignores the meta tag still sees this. */
  @Header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  /* Nothing here may sit in a shared cache. The response is one person's
     financial record keyed only by a URL. */
  @Header('Cache-Control', 'no-store, private')
  async read(@Param('token') token: string, @Res({ passthrough: true }) res: Response) {
    const share = await this.shares.resolve(token);
    if (!share) {
      /* Deliberately vague, and deliberately the same for all three causes. */
      throw new NotFoundException('লিংকটি আর কাজ করছে না।');
    }

    res.setHeader('Referrer-Policy', 'no-referrer');
    return this.statements.render(share);
  }
}
