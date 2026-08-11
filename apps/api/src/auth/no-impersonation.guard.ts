import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from './current-user.decorator';

/**
 * Refuse a support session.
 *
 * Impersonation exists so an operator can *see* what a customer sees. A handful
 * of routes are not seeing — they change the customer's credentials, sign their
 * devices out, or copy their books out of the product — and an operator doing
 * any of those while wearing somebody else's face is indistinguishable, in the
 * data left behind, from the customer doing it themselves.
 *
 * It reads `impersonatedBy`, which comes from the `imp` claim on the token
 * rather than from anything the client sends. A support token cannot be talked
 * out of being one.
 *
 * Placed after `JwtAuthGuard` in the `@UseGuards` list, so an unauthenticated
 * request is still a 401 rather than this. 403 rather than 404 on purpose: the
 * route plainly exists, the operator can see it in the product they are
 * supporting, and pretending otherwise would send them hunting for a bug.
 */
@Injectable()
export class NoImpersonationGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    if (request.user?.impersonatedBy) {
      throw new ForbiddenException(
        'সাপোর্ট সেশন থেকে এই কাজটি করা যায় না — গ্রাহকের অ্যাকাউন্টে নিজে সাইন ইন করে করতে হবে',
      );
    }
    return true;
  }
}
