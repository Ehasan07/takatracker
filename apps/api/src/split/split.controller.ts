import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import { SplitService } from './split.service';

/**
 * Groups, shared bills, and settling up.
 *
 * Every route is workspace-scoped by the guard and by the service; a group id
 * from somebody else's workspace answers 404, not 403, for the reason the rest
 * of this API gives: "not yours" and "not there" must look the same from
 * outside.
 *
 * The shapes here are the contract a native app will use later, so they are
 * plain JSON with integer minor units and `YYYY-MM-DD` dates — no
 * browser-specific types, nothing that needs a web client to interpret.
 */

const PURPOSES = ['TRIP', 'HOUSEHOLD', 'OFFICE', 'EVENT', 'OTHER'] as const;
const METHODS = ['EQUAL', 'EXACT', 'PERCENT', 'SHARES'] as const;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'তারিখ YYYY-MM-DD আকারে দিন');

const memberSchema = z.object({
  personId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  /* What makes this the same person as one already on the books. Without it a
     member is created from the name alone, and two people called করিম are two
     people — see `personIdentityKeys`. */
  phone: z.string().trim().max(30).optional(),
  email: z.string().trim().max(200).optional(),
  shareWeight: z.number().int().min(0).max(1000).optional(),
});

const createGroupSchema = z.object({
  name: z.string().trim().min(1).max(120),
  purpose: z.enum(PURPOSES).optional(),
  currency: z.string().trim().length(3).optional(),
  note: z.string().trim().max(500).optional(),
  members: z.array(memberSchema).max(50).optional(),
});

const updateGroupSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  purpose: z.enum(PURPOSES).optional(),
  note: z.string().trim().max(500).nullable().optional(),
  archived: z.boolean().optional(),
});

const expenseSchema = z.object({
  description: z.string().trim().min(1).max(200),
  date: DATE,
  totalMinor: z.number().int().positive(),
  payerMemberId: z.string().min(1),
  splitMethod: z.enum(METHODS),
  shares: z
    .array(
      z.object({
        memberId: z.string().min(1),
        amountMinor: z.number().int().min(0).optional(),
        percentBps: z.number().int().min(0).max(10_000).optional(),
        shareWeight: z.number().int().min(0).max(1000).optional(),
      }),
    )
    .min(1)
    .max(50),
  categoryId: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
  fromPot: z.boolean().optional(),
  note: z.string().trim().max(500).optional(),
  attachmentIds: z.array(z.string()).max(10).optional(),
});

const potSchema = z.object({ name: z.string().trim().min(1).max(120).optional() });

const contributionSchema = z.object({
  memberId: z.string().min(1),
  amountMinor: z.number().int().positive(),
  date: DATE,
  accountId: z.string().min(1).optional(),
  note: z.string().trim().max(500).optional(),
});

const settleSchema = z.object({
  fromMemberId: z.string().min(1),
  toMemberId: z.string().min(1),
  amountMinor: z.number().int().positive(),
  date: DATE,
  accountId: z.string().min(1).optional(),
  note: z.string().trim().max(500).optional(),
});

@Controller('split/groups')
@UseGuards(JwtAuthGuard)
export class SplitController {
  constructor(private readonly split: SplitService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.split.listGroups(user);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(zodPipe(createGroupSchema)) body: z.infer<typeof createGroupSchema>,
  ) {
    return this.split.createGroup(user, body);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.split.findGroup(user, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(updateGroupSchema)) body: z.infer<typeof updateGroupSchema>,
  ) {
    return this.split.updateGroup(user, id, body);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.split.removeGroup(user, id);
  }

  @Post(':id/members')
  addMember(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(memberSchema)) body: z.infer<typeof memberSchema>,
  ) {
    return this.split.addMember(user, id, body);
  }

  @Delete(':id/members/:memberId')
  removeMember(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('memberId') memberId: string,
  ) {
    return this.split.removeMember(user, id, memberId);
  }

  @Get(':id/expenses')
  expenses(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.split.listExpenses(user, id);
  }

  @Post(':id/expenses')
  addExpense(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(expenseSchema)) body: z.infer<typeof expenseSchema>,
  ) {
    return this.split.createExpense(user, id, body);
  }

  @Delete(':id/expenses/:expenseId')
  removeExpense(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('expenseId') expenseId: string,
  ) {
    return this.split.removeExpense(user, id, expenseId);
  }

  /**
   * Invite a member who has an account of their own.
   *
   * Accepting does not give this workspace write access to theirs. It says
   * "send me the bills I am on, as drafts" — each one posts only when they
   * accept it, which is the same rule the mailbox ingestion follows.
   */
  @Post(':id/members/:memberId/invite')
  invite(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('memberId') memberId: string,
  ) {
    return this.split.invite(user, id, memberId);
  }

  /** Turn a group into a fund: a family kitty, an office samity, a trip pot. */
  @Post(':id/pot')
  openPot(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(potSchema)) body: z.infer<typeof potSchema>,
  ) {
    return this.split.openPot(user, id, body.name);
  }

  @Get(':id/contributions')
  contributions(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.split.listContributions(user, id);
  }

  @Post(':id/contributions')
  contribute(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(contributionSchema)) body: z.infer<typeof contributionSchema>,
  ) {
    return this.split.contribute(user, id, body);
  }

  @Get(':id/settlements')
  settlements(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.split.listSettlements(user, id);
  }

  @Post(':id/settlements')
  settle(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(settleSchema)) body: z.infer<typeof settleSchema>,
  ) {
    return this.split.settle(user, id, body);
  }
}
