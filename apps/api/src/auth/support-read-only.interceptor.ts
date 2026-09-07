import {
  type CallHandler,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import type { AuthUser } from './current-user.decorator';

/**
 * A support session may look. It may not write.
 *
 * ## Why this exists at all
 *
 * `AdminImpersonationService` says the uncomfortable part plainly: an ordinary
 * write made during a support session is audited as the customer,
 * `actorType: 'USER'`, because attributing it otherwise would mean editing
 * every audit call site in the application. Only the start and end rows name
 * the operator. So a transaction created inside a session is, in the data left
 * behind, a transaction the customer created — and the customer is never told a
 * session happened at all.
 *
 * That is survivable while the session cannot create one. This interceptor is
 * what makes that true: every method that is not a read is refused for the life
 * of the session, so the gap between "who acted" and "whose name is on the row"
 * can never open.
 *
 * The alternative — allowing writes and threading `impersonatedBy` through
 * every `AuditService.record` call — is a real option and a much larger change.
 * Until somebody does it, this is the honest position rather than a smaller one
 * that reads as the same thing.
 *
 * ## Why an interceptor and not a guard
 *
 * A global `APP_GUARD` runs *before* the controller-bound `JwtAuthGuard`, so
 * `request.user` is not populated yet and `impersonatedBy` would read
 * `undefined` on every request — a check that passes everything, which is worse
 * than no check because it looks like one. Interceptors run after all guards
 * have resolved, which is exactly when the question can be answered.
 *
 * ## Why it reads the token and not a header
 *
 * `impersonatedBy` comes from the `imp` claim, set only by
 * `AuthService.signAccessToken` when the admin module asks for it. A client
 * cannot talk its token out of being a support token, so it cannot talk its way
 * past this.
 *
 * ## What is deliberately not exempted
 *
 * `POST /admin/impersonate/end` is not on a list here and does not need to be:
 * it is called with the *operator's own* cookie session, which carries no `imp`
 * claim, so it never reaches this branch. The way out of a support session is
 * never blocked by it.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class SupportReadOnlyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(SupportReadOnlyInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    /* Scheduled work and queue consumers have no HTTP request and no session.
     * Reading `switchToHttp()` on them would hand back an empty object whose
     * `.method` is undefined — which `SAFE_METHODS` would then reject, taking
     * the cron jobs down for a reason nobody would guess from the message. */
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const operatorId = request.user?.impersonatedBy;
    if (!operatorId) return next.handle();

    const method = (request.method ?? 'GET').toUpperCase();
    if (SAFE_METHODS.has(method)) return next.handle();

    /* Logged with both identities because the audit table cannot record this
     * one: the row would be filed against the customer's workspace as the
     * customer, which is the exact confusion this interceptor exists to
     * prevent. The journal is the right home for a refusal. */
    this.logger.warn(
      `Support session refused a write: operator ${operatorId} acting as ${request.user?.id} ` +
        `attempted ${method} ${request.originalUrl ?? request.url}`,
    );

    throw new ForbiddenException(
      'সাপোর্ট সেশন শুধু দেখার জন্য — এই সেশন থেকে কোনো তথ্য যোগ, বদল বা মুছে ফেলা যায় না',
    );
  }
}
