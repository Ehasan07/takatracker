import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ACCESS_COOKIE, type JwtPayload } from '../auth/jwt.strategy';
import { jwtAccessSecret } from '../common/env';
import {
  INGEST_SECRET_HEADER,
  INGEST_WORKSPACE_HEADER,
  verifyIngestWebhookSecret,
} from '../common/ingest-webhook';

/**
 * Rate limiting, bucketed by tenant instead of by address.
 *
 * ## Why the address is the wrong axis
 *
 * `trust proxy = 1` means `req.ip` is finally the client rather than nginx, so
 * the number is at least honest now. It is still the wrong thing to count.
 *
 * Most of this product's users reach it over a Bangladeshi mobile carrier, and
 * those carriers NAT aggressively: Grameenphone, Robi and Banglalink put
 * thousands of subscribers behind a handful of addresses. Per-IP therefore gets
 * it wrong in both directions at once. One workspace with a busy dashboard
 * spends the shared budget and every unrelated person on that carrier gets a
 * 429 they cannot explain and cannot fix. Meanwhile a single tenant who wants
 * to hammer the API only has to switch between wifi and mobile data, or run
 * from a few cheap VPS addresses, to multiply their allowance by the number of
 * addresses they can reach.
 *
 * The workspace is the unit the product actually sells, the unit a limit is
 * meant to protect, and — unlike an address — the unit a caller cannot change
 * without a credential. So that is what this counts.
 *
 * ## The three axes, in order
 *
 *  1. **A verified access token → the workspace it names.** Bucket `ws:<id>`.
 *  2. **A verified ingestion webhook secret → the workspace in its header.**
 *     Also bucket `ws:<id>`; that endpoint has no JWT, see below.
 *  3. **Anything else → the client address.** Bucket `ip:<addr>`, which is what
 *     every request got before this class existed.
 *
 * The limits themselves are untouched — same `ttl`, same numbers, same
 * per-route `@Throttle` overrides. Only the suffix `generateKey` hashes
 * changes, so if 429s move after this ships, the axis is the only thing that
 * can have caused it.
 *
 * ## Why the token is verified here rather than read
 *
 * This guard is registered as an `APP_GUARD`, and Nest runs global guards
 * *before* controller and route guards (`[...global, ...class, ...handler]` in
 * `ContextCreator.createContext`). So `JwtAuthGuard` has not run yet and
 * `req.user` does not exist — reading it would silently bucket every request by
 * IP and this class would be decoration.
 *
 * That leaves reading the token directly, and it must be *verified*, not
 * decoded. An unverified `ws` claim is attacker-controlled, and either way it
 * goes wrong:
 *
 *  - a fresh made-up workspace id per request is a fresh bucket per request,
 *    which is not a rate limit at all;
 *  - a *victim's* workspace id spends somebody else's budget, which turns the
 *    limiter into a denial-of-service tool aimed at a named tenant.
 *
 * Verification is one HMAC against the same memoised secret `JwtStrategy` uses,
 * with no database round trip. A token that is expired, forged, or signed with
 * a rotated key fails here exactly as it will fail in `JwtStrategy` a moment
 * later, and falls through to the IP bucket — the strict side. Note what this
 * deliberately does *not* re-check: membership status, workspace suspension,
 * `tokenVersion`. Those are authentication's job and they cost a query. A
 * revoked member whose token has not expired keeps counting against the
 * workspace they were revoked from, and then gets a 401. That is the right
 * trade: the throttler decides which counter to increment, not who may pass.
 *
 * ## Why the webhook secret is verified too
 *
 * `POST /v1/ingestion/webhook` is authenticated by a per-workspace shared
 * secret in a header, not a JWT, and the workspace id is in a header beside it.
 * Bucketing on that header as it arrives would be worse than useless: anyone
 * could send `x-hishab-workspace: <random>` on every request and mint a new
 * bucket each time, so the endpoint's 60/min would become unbounded. The secret
 * is one HMAC and no query — the controller is about to compute it anyway — so
 * the header is only trusted once it has been proven. A wrong or missing secret
 * lands in the IP bucket, which also means brute-forcing the secret stays
 * capped per address.
 *
 * ## What is deliberately left per-IP
 *
 * Login, signup, refresh, password reset, email verification, and the Telegram
 * webhook. None of them can name a workspace before they succeed, and this is
 * exactly where credential stuffing lands, so the fallback keeps the tight
 * per-route ceilings `auth.controller.ts` already sets (`@Throttle(rate(5))`
 * for signup and forgot-password, `rate(10)` for login) against the address.
 * Carrier NAT makes that fallback share a bucket across strangers, which is
 * unpleasant for them and correct for us: an unauthenticated caller has offered
 * nothing else to count.
 */
@Injectable()
export class WorkspaceThrottlerGuard extends ThrottlerGuard {
  private readonly log = new Logger(WorkspaceThrottlerGuard.name);

  /**
   * Built on first use, not in a field initialiser: `jwtAccessSecret()` must be
   * read after `ConfigModule.forRoot` has populated `process.env`, and it
   * throws in production when the secret is missing. Constructing it lazily
   * keeps that failure on the request path's first call rather than turning it
   * into a DI error with no context.
   */
  private jwt?: JwtService;

  private verifier(): JwtService {
    this.jwt ??= new JwtService({ secret: jwtAccessSecret() });
    return this.jwt;
  }

  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const workspaceId = this.workspaceOf(req);
    if (workspaceId) return `ws:${workspaceId}`;
    return `ip:${addressOf(req)}`;
  }

  /** The workspace this request can *prove* it belongs to, or null. */
  private workspaceOf(req: Record<string, unknown>): string | null {
    /* Defensive: this guard is global, so `user` is not populated yet. If it is
     * ever also applied route-scoped after JwtAuthGuard, prefer the object
     * authentication actually validated over re-reading the token. */
    const user = req.user as { workspaceId?: unknown } | undefined;
    if (typeof user?.workspaceId === 'string' && user.workspaceId !== '') {
      return user.workspaceId;
    }

    return this.workspaceFromToken(req) ?? this.workspaceFromIngestHeaders(req);
  }

  private workspaceFromToken(req: Record<string, unknown>): string | null {
    const token = accessTokenOf(req);
    if (!token) return null;

    try {
      const payload = this.verifier().verify<JwtPayload>(token);
      return typeof payload.ws === 'string' && payload.ws !== '' ? payload.ws : null;
    } catch {
      /* Expired, forged, or signed with a key we have rotated away from. Not
       * worth a log line — it happens every time a tab wakes up with a stale
       * cookie — and the request is about to be refused by JwtStrategy anyway.
       * Counting it against the address is the strict answer. */
      return null;
    }
  }

  private workspaceFromIngestHeaders(req: Record<string, unknown>): string | null {
    const workspaceId = headerOf(req, INGEST_WORKSPACE_HEADER);
    const secret = headerOf(req, INGEST_SECRET_HEADER);
    if (!workspaceId || !secret) return null;

    if (!verifyIngestWebhookSecret(workspaceId, secret)) return null;
    return workspaceId;
  }

  /**
   * Kept only so a deployment can be told, once, which axis it is on. The
   * guard itself never logs per request.
   */
  onApplicationBootstrap(): void {
    this.log.log('Rate limiting by workspace where the request proves one, by IP otherwise');
  }
}

/** Web sends the access token as an httpOnly cookie; mobile sends a bearer header. */
function accessTokenOf(req: Record<string, unknown>): string | null {
  const authorization = headerOf(req, 'authorization');
  if (authorization) {
    const [scheme, value] = authorization.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && value) return value;
  }

  const cookies = req.cookies as Record<string, string> | undefined;
  return cookies?.[ACCESS_COOKIE] ?? null;
}

function headerOf(req: Record<string, unknown>, name: string): string | null {
  const headers = req.headers as Record<string, string | string[] | undefined> | undefined;
  const raw = headers?.[name];
  if (typeof raw === 'string') return raw === '' ? null : raw;
  /* Node lower-cases header names and joins repeats for everything except
   * set-cookie, so an array here means the client sent the header twice. Take
   * neither: an ambiguous workspace claim must not pick a bucket. */
  return null;
}

/**
 * `req.ip` is Express's, which honours `trust proxy = 1` and is therefore the
 * address our own nginx observed. The socket fallback is for the case where
 * this guard runs outside an Express request (it should not) and for a socket
 * that has already closed; a shared `unknown` bucket is strict, not lenient.
 */
function addressOf(req: Record<string, unknown>): string {
  if (typeof req.ip === 'string' && req.ip !== '') return req.ip;
  const socket = req.socket as { remoteAddress?: string } | undefined;
  return socket?.remoteAddress ?? 'unknown';
}
