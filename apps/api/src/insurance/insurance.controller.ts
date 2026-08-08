import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { cuid, isoDate, minorAmount } from '@hishab/shared';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { zodPipe } from '../common/zod.pipe';
import { InsuranceService } from './insurance.service';

/* Mirrors of the Prisma enums. Kept local until insurance earns a place in
 * @hishab/shared, so the client contract has one obvious home to move to. */
const PLAN_FREQUENCIES = ['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY'] as const;
const POLICY_STATUSES = ['ACTIVE', 'LAPSED', 'MATURED', 'CANCELLED'] as const;

const policyFields = z.object({
  insurer: z.string().min(1).max(120),
  /* Never the full number: a policy number is enough to impersonate the holder
   * over the phone, and the last four digits identify it just as well. */
  policyNumberMasked: z.string().max(60).optional(),
  policyType: z.string().max(60).optional(),
  sumAssuredMinor: minorAmount.nonnegative().default(0),
  premiumMinor: minorAmount.nonnegative().default(0),
  frequency: z.enum(PLAN_FREQUENCIES).default('YEARLY'),
  startDate: isoDate,
  /* Either of these fixes the term; the service insists on at least one and
   * derives the other, because the schedule cannot be built without it. */
  termMonths: z.number().int().min(1).max(1200).optional(),
  maturityDate: isoDate.optional(),
  nomineeName: z.string().max(120).optional(),
  note: z.string().max(2000).optional(),
});

const createPolicySchema = policyFields;
export type CreatePolicyInput = z.infer<typeof createPolicySchema>;

const updatePolicySchema = policyFields.partial().extend({
  status: z.enum(POLICY_STATUSES).optional(),
});
export type UpdatePolicyInput = z.infer<typeof updatePolicySchema>;

const payPremiumSchema = z.object({
  /** Defaults to today in the workspace timezone. */
  paidDate: isoDate.optional(),
  /** Overrides the scheduled amount when the insurer took something else. */
  amountMinor: minorAmount.nonnegative().optional(),
  /** The ledger transaction that moved the money, once one exists. */
  transactionId: cuid.optional(),
});
export type PayPremiumInput = z.infer<typeof payPremiumSchema>;

@Controller('insurance')
@UseGuards(JwtAuthGuard)
export class InsuranceController {
  constructor(private readonly insurance: InsuranceService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.insurance.list(user.workspaceId, user.timezone);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body(zodPipe(createPolicySchema)) body: CreatePolicyInput,
  ) {
    return this.insurance.create(user.workspaceId, user.id, body, user.timezone);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.insurance.findOne(user.workspaceId, id, user.timezone);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(zodPipe(updatePolicySchema)) body: UpdatePolicyInput,
  ) {
    return this.insurance.update(user.workspaceId, user.id, id, body, user.timezone);
  }

  @Post(':id/premiums/:premiumId/pay')
  @HttpCode(200)
  pay(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('premiumId') premiumId: string,
    @Body(zodPipe(payPremiumSchema)) body: PayPremiumInput,
  ) {
    return this.insurance.payPremium(user.workspaceId, user.id, id, premiumId, body, user.timezone);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.insurance.remove(user.workspaceId, user.id, id);
  }
}
