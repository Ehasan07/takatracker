import { Body, Controller, Headers, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import { FeedbackService, MAX_MESSAGE_LENGTH } from './feedback.service';

/**
 * The burst ceiling, matching `auth.controller.ts`'s helper exactly — including
 * the way it stands down under test, because the e2e suite drives every request
 * from one address and would otherwise trip a limit it is not testing.
 *
 * This is the *only* one that stands down. The daily cap in `FeedbackService`
 * counts rows and stays on in tests, which is what makes the flood ceiling
 * something a test can actually assert rather than something we hope is wired.
 */
const isTest = process.env.NODE_ENV === 'test';
const rate = (limit: number) => ({ default: { limit: isTest ? 10_000 : limit, ttl: 60_000 } });

/**
 * The path a person was on, reduced to something safe to store.
 *
 * The browser sends `window.location.pathname` and the server trusts none of
 * it. Three things happen here:
 *
 * - **A full URL is reduced to its path.** A client that sends
 *   `https://app.example/reports?from=2026-01-01&account=clx…` would otherwise
 *   put a date range and an account id into a table an operator reads, and
 *   neither is any of the operator's business.
 * - **Anything not starting with `/` is dropped.** It is a path or it is
 *   nothing; a value we cannot recognise is not worth guessing at.
 * - **It is length-capped.** A route in this app is thirty characters; two
 *   hundred is room for an id and a slug, and a refusal to store an essay.
 */
export function normaliseScreen(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  /* Everything after the path is deliberately discarded, query string and
     fragment alike. `URL` is not used: it would resolve a relative path against
     nothing and throw, and the substring is unambiguous. */
  const path = trimmed.split(/[?#]/)[0] ?? '';
  if (!path.startsWith('/')) return null;

  return path.slice(0, 200);
}

const feedbackSchema = z.object({
  /* Defaulted rather than required. A person who typed a paragraph and never
     touched the picker has still told us something, and refusing the whole
     submission over a taxonomy we invented would lose it. */
  kind: z.enum(['PROBLEM', 'IDEA', 'OTHER']).default('OTHER'),
  /* `min(1)` after `trim()`, so a message of spaces is refused for the reason
     it should be — there is nothing in it — rather than passing a length check
     and arriving as a blank row. */
  message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
  /* Loose on the way in and narrowed by `normaliseScreen`, following the
     `searchAliases` pattern in `tags.controller.ts`: zod's own type error would
     arrive in English, and this field is a courtesy that must never be the
     reason a report is lost. */
  screen: z.unknown().optional(),
});

@Controller('feedback')
@UseGuards(JwtAuthGuard)
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  /**
   * `POST /v1/feedback` — what is broken, or what they wish existed.
   *
   * Five a minute. Somebody reporting three things in one sitting is the case
   * this is built for and fits comfortably; a script does not.
   */
  @Post()
  @Throttle(rate(5))
  submit(
    @CurrentUser() user: AuthUser,
    @Body(zodPipe(feedbackSchema)) body: ReturnType<typeof feedbackSchema.parse>,
    /* Verbatim and capped. "The keypad does not work" is unanswerable without
       knowing it was an old Android WebView, and asking the person to find that
       out themselves is asking them not to report it. */
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.feedback.submit(user, {
      kind: body.kind,
      message: body.message,
      screen: normaliseScreen(body.screen),
      userAgent: userAgent?.slice(0, 500) ?? null,
    });
  }
}
