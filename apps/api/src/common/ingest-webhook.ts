import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The ingestion webhook's shared-secret scheme, as pure functions.
 *
 * It lives here rather than on `IngestionService` because two things now need
 * it and only one of them can hold a service: the controller, which decides
 * whether to answer 401, and `WorkspaceThrottlerGuard`, which decides which
 * bucket the request counts against. The guard is a global `APP_GUARD` and runs
 * before anything in `IngestionModule` exists as far as the request is
 * concerned, so it cannot ask the service; and it must not skip the check,
 * because the workspace arrives in an ordinary header. See the guard for what
 * an unverified header would cost.
 *
 * Nothing in here touches the database or the request. It is `INGESTION_WEBHOOK_SECRET`,
 * a workspace id, and an HMAC.
 */

/** Which workspace the forwarder is posting for. */
export const INGEST_WORKSPACE_HEADER = 'x-hishab-workspace';

/** The per-workspace shared secret. */
export const INGEST_SECRET_HEADER = 'x-hishab-ingest-secret';

/**
 * Domain separator for the derived secret. Bump the version if the derivation
 * ever changes: every workspace's webhook secret changes with it, and every
 * forwarder has to be reconfigured, so it must be a deliberate act.
 */
const SECRET_PURPOSE = 'hishab.ingest.webhook.v1';

/**
 * The secret a given workspace's forwarder must present, or `null` when the
 * root secret is unset — which is how the endpoint stays closed by default
 * rather than falling back to something guessable.
 */
export function ingestWebhookSecretFor(
  workspaceId: string,
  root = process.env.INGESTION_WEBHOOK_SECRET,
): string | null {
  if (!root) return null;
  return createHmac('sha256', root).update(`${SECRET_PURPOSE}:${workspaceId}`).digest('base64url');
}

/**
 * Constant time, always.
 *
 * `timingSafeEqual` throws on a length mismatch and returning early on length
 * would leak it, so both sides are hashed first: the digests are always 32
 * bytes and are equal exactly when the inputs are.
 */
function equalsInConstantTime(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/**
 * Whether `provided` is this workspace's webhook secret, under either the
 * current root or the previous one during a rotation.
 *
 * Silent: it returns false and says nothing, because the throttler calls it on
 * every webhook request and a warning per request is a log flood. The service
 * wrapper does the warning once the request is actually being refused.
 */
export function verifyIngestWebhookSecret(
  workspaceId: string | undefined,
  provided: string | undefined,
): boolean {
  if (!workspaceId || !provided) return false;

  const current = ingestWebhookSecretFor(workspaceId, process.env.INGESTION_WEBHOOK_SECRET);
  if (!current) return false;

  const previous = ingestWebhookSecretFor(
    workspaceId,
    process.env.INGESTION_WEBHOOK_SECRET_PREVIOUS,
  );

  /* Bitwise or, not `||`: both comparisons run whatever the first one says, so
   * the response time cannot reveal which secret matched. Whether a previous
   * secret is configured at all is a property of the server, not of the
   * attacker's guess, so branching on that is safe. */
  const matchesCurrent = Number(equalsInConstantTime(provided, current));
  const matchesPrevious = Number(previous ? equalsInConstantTime(provided, previous) : false);
  return (matchesCurrent | matchesPrevious) === 1;
}
