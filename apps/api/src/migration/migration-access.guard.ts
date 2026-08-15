import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthUser } from '../auth/current-user.decorator';

/**
 * Who is allowed to move a chart of accounts in from another product.
 *
 * ## Why an allowlist and not a plan feature
 *
 * This is not a tier of the product. It is one person's one-afternoon tool for
 * leaving BudgetBakers, and it asks that person to paste a live credential to
 * another finance account into a form. Offering that to every customer would be
 * offering a phishing shape as a feature — and the day somebody imitates this
 * screen, "Taka Tracker asks for your other app's password" is already true.
 *
 * So it is off unless the signed-in address is named in `MIGRATION_ALLOWED_EMAILS`,
 * which lives in `/etc/hishab/hishab.env` beside the other secrets. Empty or
 * unset means nobody, deliberately: a deploy that loses the variable closes the
 * door rather than opening it to everyone.
 *
 * ## It hides as well as refuses
 *
 * `GET /migration/availability` is the one route this does not guard, so the
 * navigation can ask "should I draw this?" and get an answer rather than a 403.
 * Everything else answers 403 whatever the browser believes.
 */

/** Case and surrounding space ignored; nothing else about an address is. */
export function migrationAllowlist(): Set<string> {
  return new Set(
    (process.env.MIGRATION_ALLOWED_EMAILS ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

/**
 * An address, or a whole domain written as `@example.com`.
 *
 * The domain form is there because the alternative — one address — makes this
 * impossible to test without a fixed account that every run has to share, and
 * because allowlisting a company's own domain is the obvious next thing to ask
 * for. It is still an allowlist: `@` alone matches nothing.
 */
export function migrationAllowed(email: string | undefined): boolean {
  const allowed = migrationAllowlist();
  if (allowed.size === 0) return false;

  const address = (email ?? '').trim().toLowerCase();
  if (!address) return false;
  if (allowed.has(address)) return true;

  const at = address.lastIndexOf('@');
  if (at < 0) return false;
  const domain = address.slice(at);
  return domain.length > 1 && allowed.has(domain);
}

@Injectable()
export class MigrationAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    if (!migrationAllowed(request.user?.email)) {
      /* Deliberately says the feature is not open rather than "you are not on
         the list": the second sentence invites somebody to ask how to get on
         it, and there is no answer to that question. */
      throw new ForbiddenException('এই সুবিধাটি এই অ্যাকাউন্টে চালু নেই');
    }
    return true;
  }
}
