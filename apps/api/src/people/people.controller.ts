import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { cuid } from '@hishab/shared';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import { PeopleService } from './people.service';

/**
 * The write body.
 *
 * Local rather than in @hishab/shared, following `tagBodySchema` and
 * `categoryBodySchema`. The lengths mirror what the loan form already accepts
 * for the same values — `personName` at 120, `personPhone` at 30 — so a person
 * created here and a person created by recording a loan cannot end up with
 * different limits on the same column.
 *
 * The phone is validated for *length* only. Shape is decided in `./phone`,
 * which normalises what it recognises and keeps everything else verbatim: a zod
 * pattern here would have to either refuse a landline or duplicate those rules,
 * and both are worse than one place that knows what a Bangladeshi number is.
 */
const personBodySchema = z.object({
  name: z.string().min(1).max(120),
  phone: z.string().max(30).nullish(),
  /* The second thing that identifies somebody. A colleague may have no
     Bangladeshi mobile and an office group still has to reach them. */
  email: z.string().max(200).nullish(),
  relation: z.string().max(60).nullish(),
  note: z.string().max(2000).nullish(),
  photoUri: z.string().max(500).nullish(),
});

const updatePersonSchema = personBodySchema.partial();

const mergePersonSchema = z.object({ intoPersonId: cuid });

@Controller('people')
@UseGuards(JwtAuthGuard)
export class PeopleController {
  constructor(private readonly people: PeopleService) {}

  /**
   * `GET /v1/people?q=` — the workspace's contacts, each with how many loans are
   * open with them, what is outstanding in each direction, and when anything
   * last happened.
   *
   * `q` searches the name, the phone, the relation and the note through the
   * @hishab/core matcher, so `karim` and `korim` both find করিম. It arrives
   * untyped — express turns a repeated parameter into an array — and is narrowed
   * in the service, where the Bengali refusals live.
   */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query('q') q?: unknown) {
    return this.people.list(user, { q });
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.people.findOne(user, id);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(zodPipe(personBodySchema)) body: ReturnType<typeof personBodySchema.parse>,
  ) {
    return this.people.create(user, body);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(updatePersonSchema)) body: ReturnType<typeof updatePersonSchema.parse>,
  ) {
    return this.people.update(user, id, body);
  }

  /**
   * Soft delete, and refused outright while any live loan still names them — a
   * receivable pointing at nobody is money owed by nobody. The refusal says how
   * many loans are in the way. Transactions are left pointing at the tombstone
   * so the khata keeps the name it was filed under.
   */
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.people.remove(user, id);
  }

  /** Fold `:id` into `intoPersonId`: loans, their payments, transactions. */
  @Post(':id/merge')
  merge(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(mergePersonSchema)) body: ReturnType<typeof mergePersonSchema.parse>,
  ) {
    return this.people.merge(user, id, body.intoPersonId);
  }
}
