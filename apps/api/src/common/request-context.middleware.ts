import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { runWithRequestContext } from './request-context';

/**
 * Opens the request context around everything that follows.
 *
 * Middleware rather than a guard or an interceptor, and that is the whole
 * reason it is a separate file: middleware is the only hook that runs *around*
 * the rest of the request. A guard returns before the handler executes and an
 * interceptor's `next.handle()` is subscribed after the interceptor has
 * returned, so an `AsyncLocalStorage.run` in either would have closed before
 * the code that needs the context ran — and would have failed silently, which
 * for an audit trail is worse than failing loudly.
 *
 * Registered in `AppModule.configure` rather than in `main.ts` so it also
 * applies under `Test.createTestingModule`, which never runs `main.ts`. An
 * attribution that is absent from the test suite is an attribution nobody can
 * prove works.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(_req: Request, _res: Response, next: NextFunction): void {
    runWithRequestContext(() => next());
  }
}
