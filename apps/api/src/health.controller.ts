import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from './prisma/prisma.service';

type HealthPayload = {
  status: 'ok' | 'degraded';
  db: boolean;
  version: string;
  /* Short git SHA and release stamp, written into /etc/hishab/release.env by
   * infra/deploy/20-release.sh (and rewritten by 50-rollback.sh). 'unknown'
   * means the process was started outside the deploy scripts. */
  commit: string;
  release: string;
  releasedAt: string;
};

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /* 503 — not 200 — when the database is unreachable.
   *
   * infra/deploy/20-release.sh verifies a release by curling this endpoint with
   * `curl -fsS`, and Playwright waits on it as a readiness probe. While this
   * returned 200 with {"status":"degraded"}, a deploy that could not reach
   * Postgres reported success and exited 0. The body is deliberately unchanged
   * so anything already parsing it keeps working; only the status code moves. */
  @Get()
  async check(@Res({ passthrough: true }) res: Response): Promise<HealthPayload> {
    let db = false;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      db = true;
    } catch {
      db = false;
    }

    if (!db) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }

    return {
      status: db ? 'ok' : 'degraded',
      db,
      version: process.env.APP_VERSION ?? '0.1.0',
      commit: process.env.GIT_SHA ?? 'unknown',
      release: process.env.RELEASE_ID ?? 'unknown',
      releasedAt: process.env.RELEASED_AT ?? 'unknown',
    };
  }
}
