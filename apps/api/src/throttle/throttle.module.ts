import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { WorkspaceThrottlerGuard } from './workspace-throttler.guard';

/**
 * The default ceiling, unchanged from when it lived in `app.module.ts`.
 *
 * Note what `@nestjs/throttler` actually does with it: `generateKey` hashes
 * `<Controller>-<handler>-<name>-<tracker>`, so this is 120 requests a minute
 * *per route* per bucket, not 120 across the API. That was already true and is
 * not being changed here.
 *
 * The e2e suite drives every request from 127.0.0.1 and, now, mostly from two
 * or three workspaces, so it raises the ceiling rather than tripping over
 * itself.
 */
const DEFAULT_LIMIT = Number(
  process.env.THROTTLE_LIMIT ?? (process.env.NODE_ENV === 'test' ? 100_000 : 120),
);

/**
 * Rate limiting, in one place.
 *
 * The only thing this changes about the previous `ThrottlerModule.forRoot` in
 * `app.module.ts` is which guard class is bound to `APP_GUARD` — see
 * `WorkspaceThrottlerGuard` for why the axis moved from address to workspace.
 * The window and the numbers are byte-for-byte what they were, deliberately:
 * moving the axis and the limits in one change would make it impossible to
 * attribute whatever the 429 graph does next.
 */
@Module({
  imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: DEFAULT_LIMIT }])],
  providers: [{ provide: APP_GUARD, useClass: WorkspaceThrottlerGuard }],
})
export class ThrottleModule {}
