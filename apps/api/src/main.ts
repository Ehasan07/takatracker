import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { installBigIntJson } from './common/bigint-json';
import { assertProductionEnv } from './common/env';

async function bootstrap(): Promise<void> {
  /* Before anything else. Importing AppModule above has already run
   * ConfigModule.forRoot, so process.env is fully populated by now, and a
   * production box that is missing a secret — or still holding a placeholder
   * out of .env.example — must die here rather than come up and serve traffic
   * with a signing key anyone can read. Outside production this only logs. */
  assertProductionEnv();

  // Money crosses the wire as an integer JSON number, never a string or float.
  installBigIntJson();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });

  /* Exactly one hop — never `true`.
   *
   * nginx (infra/deploy/10-provision.sh) is the only proxy in front of us and
   * it sets `X-Forwarded-For: $proxy_add_x_forwarded_for`, i.e. it appends the
   * address it actually saw to whatever the client sent. So the *last* entry is
   * the one our own nginx wrote, and `trust proxy = 1` makes Express read
   * exactly that one. Without this, every request looks like 127.0.0.1: the
   * throttler buckets the whole deployment together (one active user can 429
   * everybody, since the global limit is 120/min and a dashboard view spends
   * several) and every IP in the audit log and the session list is fabricated.
   *
   * `true` would trust the whole chain and take the left-most entry, which the
   * client controls. Anyone could then send `X-Forwarded-For: 1.2.3.4`, get a
   * fresh rate-limit bucket per request, and write any address they liked into
   * the audit trail. One hop trusts our nginx and nothing else. If a CDN or a
   * second proxy is ever put in front, raise this to the number of proxies we
   * own — never to `true`.
   */
  app.set('trust proxy', 1);

  app.setGlobalPrefix('v1');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(cookieParser());

  /* Balances must never come from a cache. Without this the browser (or any
   * proxy in front of us) may heuristically cache a GET and hand the user the
   * account list from before their last transaction. */
  app.use((_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    next();
  });

  const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({ origin: origins, credentials: true });

  app.enableShutdownHooks();

  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`Hishab API listening on :${port} (prefix /v1)`);
}

void bootstrap();
