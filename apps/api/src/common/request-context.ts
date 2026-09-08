import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What the whole request knows about itself, reachable without being passed.
 *
 * ## Why this exists
 *
 * A support session is allowed to write. That is a product decision, and it has
 * one requirement attached: every row it writes has to be traceable back to the
 * operator who wrote it, because the *actor* on the row is the customer — the
 * session is their user, their workspace, their books, and `Transaction.author`
 * is correctly them. Only the audit trail can say a second person was holding
 * the keyboard.
 *
 * `AuditService.record` is called from 135 places. Threading an operator id
 * through all of them means 135 chances to forget one, and the one somebody
 * forgets is the write nobody can attribute afterwards — which is the exact
 * hole this is supposed to close. So the id travels beside the request instead
 * of through every signature, and `record` reads it in one place.
 *
 * ## Why the store is created empty and filled later
 *
 * The context has to wrap the entire request, which means middleware — and
 * middleware runs before the guards, so `req.user` does not exist yet and there
 * is nothing to put in it. The middleware therefore opens an empty store and
 * `JwtStrategy.validate` fills it in, which is the first moment the answer is
 * known and a moment every authenticated route passes through.
 *
 * ## What it is not
 *
 * Not a general-purpose bag. One field, one writer, one reader. A request
 * context that anything may add to becomes an invisible parameter list, and the
 * next person cannot tell what a service actually depends on by reading its
 * signature.
 */
export interface RequestContext {
  /**
   * The operator's user id while a support session is in force, else null.
   *
   * Comes from the `impBy` claim by way of `JwtStrategy`, never from a header
   * or a body — a client cannot talk its token into or out of being a support
   * token, so it cannot forge or erase this.
   */
  impersonatorUserId: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Opens a fresh context for one request. Called only by the middleware. */
export const runWithRequestContext = <T>(fn: () => T): T =>
  storage.run({ impersonatorUserId: null }, fn);

/**
 * `undefined` outside a request — a cron sweep, a queue consumer, a test that
 * calls a service directly. Every reader has to treat that as "no operator"
 * rather than as an error: those paths are legitimate and have no session.
 */
export const currentRequestContext = (): RequestContext | undefined => storage.getStore();

/** Called once per authenticated request, from `JwtStrategy.validate`. */
export function markImpersonated(operatorUserId: string | null): void {
  const store = storage.getStore();
  if (store) store.impersonatorUserId = operatorUserId;
}
