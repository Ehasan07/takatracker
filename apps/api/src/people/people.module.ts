import { Module } from '@nestjs/common';
import { PeopleController } from './people.controller';
import { PeopleService } from './people.service';

/**
 * Contacts: the counterparties loans are with.
 *
 * No imports. `PrismaModule` and `AuditModule` are global, and the outstanding
 * figures come from `@hishab/core`'s `summariseLoan` rather than from
 * `LoansService` — so this module does not depend on the loans module, and the
 * loans module does not depend on this one. That matters in one direction in
 * particular: `LoansService.resolvePerson` should eventually normalise its phone
 * through `./phone`, and a cycle would make that import impossible.
 *
 * `PeopleService` is exported for whoever needs it next; nothing consumes it
 * today.
 *
 * TODO(main): register `PeopleModule` in `app.module.ts` — that file belongs to
 * another change, so it is not edited here. Without the registration the five
 * routes under `/v1/people` do not exist.
 */
@Module({
  controllers: [PeopleController],
  providers: [PeopleService],
  exports: [PeopleService],
})
export class PeopleModule {}
