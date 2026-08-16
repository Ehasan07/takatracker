import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import {
  buildBalanceSheet,
  estimateTax,
  fiscalYearOf,
  fiscalYearRange,
  nextDateKey,
  type TaxEstimate,
  TaxRegimeMissingError,
  type TaxRegime,
} from '@hishab/core';
import { displayName, fromLocalDateString, toLocalDateString } from '@hishab/shared';
import { z } from 'zod';
import { AccountsService } from '../accounts/accounts.service';
import { minorToNumber } from '../common/bigint-json';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../transactions/transactions.service';
import type { UpdateTaxProfileInput } from './tax.controller';

/**
 * The income tax worksheet, and — only when a person presses a button and only
 * when somebody has checked the year's rates — an estimate.
 *
 * ## Nothing here writes to the ledger
 *
 * Every query in this file is a read. A tax estimate is a statement *about* the
 * books, and the moment it could change them it would start being circular: an
 * estimate that posts a provision alters the net wealth the next estimate is
 * computed from. The only thing this module writes is `TaxProfile`, which holds
 * two facts about the taxpayer — their category and their area — that no
 * transaction can supply.
 *
 * ## The refusal is the feature
 *
 * `estimateTax` in @hishab/core throws unless it is handed a regime whose
 * `verified` flag is true, and this service refuses one step earlier and more
 * specifically: no row for the year, a row nobody has checked, or a row marked
 * checked whose figures are missing all produce a Bengali sentence rather than a
 * number. docs/RENEWALS-AND-TAX.md §3.5 argues the case; the short version is
 * that a figure computed on last year's slabs looks exactly like one computed on
 * this year's, and nobody carrying it to their practitioner can tell.
 *
 * ## The worksheet works whether or not the rates do
 *
 * `worksheet()` never computes tax and never refuses. It is stage 1 of the plan
 * — income by head, investments, net wealth, all for a July–June window, every
 * figure traceable to the rows it came from. That is most of the tedium of
 * filing, it carries no legal exposure, and it is how the *inputs* get corrected
 * months before anybody trusts a number computed from them.
 */

/* -------------------------------------------------------------------------- */
/* Heads of income                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The heads a Bangladeshi return divides income into, as far as this product
 * can see them.
 *
 * Capital gains and agricultural income are real heads and are deliberately
 * absent: nothing in these books distinguishes them, and a head that can only
 * ever be zero is a line that tells a reader the app checked when it did not.
 */
export const HEADS_OF_INCOME = {
  SALARIES: 'বেতন',
  BUSINESS: 'ব্যবসা বা পেশা',
  HOUSE_PROPERTY: 'গৃহসম্পত্তি থেকে আয়',
  FINANCIAL_ASSETS: 'আর্থিক সম্পদ থেকে আয়',
  OTHER_SOURCES: 'অন্যান্য উৎস থেকে আয়',
} as const;

export type HeadOfIncome = keyof typeof HEADS_OF_INCOME;

/** Everything the app cannot place goes here, and says that it was placed here. */
const FALLBACK_HEAD: HeadOfIncome = 'OTHER_SOURCES';

/**
 * The seeded income categories, mapped to the heads they answer to.
 *
 * Keyed on both names a category carries, because either one may have been
 * renamed and the other left alone. docs/RENEWALS-AND-TAX.md §3.3 sets out the
 * mapping; this is that table and nothing more.
 *
 * §3.5 wants this to become a `headOfIncome` column on `Category` — data a
 * person can correct rather than a table that is wrong for somebody. It is not
 * that yet, and until it is, two things stand in for the column: a category
 * whose name has drifted falls to `OTHER_SOURCES` rather than disappearing, and
 * the worksheet reports `mapped: false` on every line that got there by falling
 * rather than by matching. A wrong head is then visible instead of silent.
 */
const HEAD_BY_CATEGORY_NAME: Readonly<Record<string, HeadOfIncome>> = {
  salary: 'SALARIES',
  বেতন: 'SALARIES',
  business: 'BUSINESS',
  ব্যবসা: 'BUSINESS',
  freelance: 'BUSINESS',
  ফ্রিল্যান্স: 'BUSINESS',
  'rental income': 'HOUSE_PROPERTY',
  'বাড়ি ভাড়া': 'HOUSE_PROPERTY',
  'profit / interest': 'FINANCIAL_ASSETS',
  'মুনাফা/সুদ': 'FINANCIAL_ASSETS',
  gift: 'OTHER_SOURCES',
  উপহার: 'OTHER_SOURCES',
  'other income': 'OTHER_SOURCES',
  অন্যান্য: 'OTHER_SOURCES',
};

/* -------------------------------------------------------------------------- */
/* Rebate-eligible investment                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Which kinds of saving the feasibility report names as rebate-eligible.
 *
 * §3.2 lists them: "DPS, life insurance premium, savings certificates,
 * provident fund, listed shares". Two of the five are modelled here as savings
 * plans, and a third as insurance policies. The rest are not in the books at
 * all, so the worksheet says so rather than implying a total is complete.
 *
 * An FDR, a goal fund and a recurring deposit are deliberately *not* on this
 * list. Whether each qualifies is a question about the Act, and the report does
 * not answer it. They are still shown on the worksheet, marked not counted and
 * carrying the reason, because a person can ask their practitioner about a
 * figure they can see and cannot ask about one the app silently dropped.
 */
const REBATE_ELIGIBLE_PLAN_TYPES = new Set(['DPS', 'SANCHAYPATRA']);

/** Why a plan that was found is not in the total. Bengali, ready to print. */
const NOT_COUNTED_REASON =
  'এই ধরনের সঞ্চয় রেয়াতযোগ্য বিনিয়োগ হিসেবে ধরা হয়নি — আয়কর বিশেষজ্ঞের সঙ্গে যাচাই করে নিন';

/* -------------------------------------------------------------------------- */
/* What the regime column holds                                               */
/* -------------------------------------------------------------------------- */

/**
 * The JSON columns, checked on the way out of the database.
 *
 * A `Json?` column is `unknown` however carefully it was written, and this one
 * decides what somebody pays. A row marked verified whose `slabs` are null, or
 * whose rates were transcribed as strings, must produce the refusal rather than
 * a crash halfway through an arithmetic — so it is parsed, and a parse failure
 * is a refusal like any other.
 */
const slabSchema = z.object({ fromMinor: z.number().int(), rateBps: z.number().int() });
const regimeFiguresSchema = z.object({
  slabs: z.array(slabSchema).min(1),
  thresholdByCategory: z.record(z.number().int()).refine((r) => Object.keys(r).length > 0),
  rebate: z.object({
    rateOfInvestmentBps: z.number().int(),
    capShareOfIncomeBps: z.number().int(),
    capAbsoluteMinor: z.number().int(),
  }),
  minimumTaxByArea: z.record(z.number().int()).refine((r) => Object.keys(r).length > 0),
  surchargeBands: z.array(slabSchema),
});

/* -------------------------------------------------------------------------- */
/* Views                                                                      */
/* -------------------------------------------------------------------------- */

/** One category's contribution to a head, and the head it landed in. */
export interface IncomeSourceLine {
  categoryId: string | null;
  name: string;
  amountMinor: number;
  /** False when the app could not place this category and used the fallback. */
  mapped: boolean;
}

export interface IncomeHeadLine {
  head: HeadOfIncome;
  label: string;
  amountMinor: number;
  /** The categories behind the figure. A total nobody can trace is not checkable. */
  sources: IncomeSourceLine[];
}

/** One savings plan or policy, and what it paid inside the year. */
export interface InvestmentLine {
  kind: 'SAVINGS' | 'INSURANCE';
  id: string;
  name: string;
  /** `DPS`, `SANCHAYPATRA`, or the policy's insurer for an insurance line. */
  detail: string | null;
  paidMinor: number;
  /** How many instalments or premiums made up the figure. */
  payments: number;
  /** Whether it is in `eligibleMinor`. */
  counted: boolean;
  /** Why not, when it is not. */
  note: string | null;
}

export interface TaxProfileView {
  country: string;
  category: string;
  area: string;
  isRequiredToFile: boolean;
  tinMasked: string | null;
}

/** Where the year's rules stand, said the same way whether or not they exist. */
export interface RegimeStatus {
  country: string;
  fiscalYear: string;
  /** The highest version for this country and year, or null when none exists. */
  version: number | null;
  found: boolean;
  verified: boolean;
  citation: string | null;
  verifiedAt: string | null;
  verifiedByName: string | null;
  /**
   * Why the calculator will refuse, in Bengali, or null when it will not.
   *
   * On the status rather than only on the error, so the screen can grey the
   * button and explain itself before anybody presses it — being told why
   * afterwards is a worse version of the same sentence.
   */
  refusal: string | null;
  /** Taxpayer categories the year defines. Empty until a year is verified. */
  categories: string[];
  /** Areas the year defines, for the minimum tax. Empty likewise. */
  areas: string[];
}

export interface TaxWorksheet {
  fiscalYear: string;
  /** Inclusive July–June bounds, from `fiscalYearRange`. */
  from: string;
  to: string;
  regime: RegimeStatus;
  profile: TaxProfileView;
  totalIncomeMinor: number;
  heads: IncomeHeadLine[];
  eligibleInvestmentMinor: number;
  investments: InvestmentLine[];
  /** Assets less liabilities as at the last day of the year, for the surcharge. */
  netWealthMinor: number;
  /** Zero, and the notes say why. See `WORKSHEET_LIMITS`. */
  taxDeductedAtSourceMinor: number;
  /** What this sheet cannot see. Printed with it, never in a footer. */
  limits: string[];
}

/** The worksheet, plus the figure — and only ever after a deliberate request. */
export interface TaxEstimateResult {
  worksheet: TaxWorksheet;
  estimate: TaxEstimate;
  /**
   * Which of the three caps decided the rebate: `investment`, `income` or
   * `absolute`.
   *
   * `rebateFor` works this out and puts it on a line's `note`; it is lifted onto
   * the result because "your rebate was capped by your income" is the single
   * most useful sentence on the sheet for somebody deciding whether to save more
   * before the year ends, and a caller should not have to go fishing in `lines`
   * for it.
   */
  rebateBoundBy: string;
}

/**
 * What the worksheet cannot see, stated on the worksheet.
 *
 * docs/RENEWALS-AND-TAX.md §3.6: cash income nobody typed is invisible and the
 * estimate will be confidently low. Saying so is not a disclaimer, it is a note
 * to a set of figures — the reader needs it to know what the total means.
 */
const WORKSHEET_LIMITS: readonly string[] = [
  'যে আয় খাতায় লেখা হয়নি — নগদ আয়, হাতে পাওয়া টাকা — এই হিসাবে নেই। তাই অঙ্কটি প্রকৃত আয়ের চেয়ে কম হতে পারে।',
  'উৎসে কর্তিত কর (TDS) আলাদা খাত হিসেবে এখনো নেই, তাই শূন্য ধরা হয়েছে। ব্যাংক বা অফিস যে কর কেটে রেখেছে তা এখানে বাদ যায়নি।',
  'ভবিষ্য তহবিল (প্রভিডেন্ট ফান্ড) ও তালিকাভুক্ত শেয়ারের বিনিয়োগ এই অ্যাপে রাখা হয় না, তাই রেয়াতের হিসাবে আসেনি।',
  'অব্যাহতিপ্রাপ্ত আয়, মূলধনি মুনাফা, বিদেশি আয় ও পরিবারের আয় একসঙ্গে গণনার নিয়ম এই হিসাবে ধরা হয়নি।',
];

@Injectable()
export class TaxService {
  private readonly logger = new Logger(TaxService.name);

  constructor(
    private readonly prisma: PrismaService,
    /* Read-only here: `systemAccounts` names the nominal income account every
       income entry is booked against, and `balances` gives the position at a
       past date. Nothing in this file asks it to write. */
    private readonly accounts: AccountsService,
  ) {}

  /** The fiscal year a workspace is currently in, in its own timezone. */
  currentFiscalYear(timezone: string): string {
    return fiscalYearOf(toLocalDateString(new Date(), timezone));
  }

  /* ------------------------------------------------------------------ */
  /* Profile                                                             */
  /* ------------------------------------------------------------------ */

  async profile(workspaceId: string): Promise<TaxProfileView> {
    const row = await this.prisma.taxProfile.findUnique({ where: { workspaceId } });
    /* Not created on read. A workspace that never opens this screen should not
       acquire a row asserting it is a general taxpayer in no particular city. */
    return {
      country: row?.country ?? 'BD',
      category: row?.category ?? 'general',
      area: row?.area ?? 'elsewhere',
      isRequiredToFile: row?.isRequiredToFile ?? true,
      tinMasked: row?.tinMasked ?? null,
    };
  }

  async saveProfile(workspaceId: string, input: UpdateTaxProfileInput): Promise<TaxProfileView> {
    const saved = await this.prisma.taxProfile.upsert({
      where: { workspaceId },
      create: { workspaceId, ...input },
      update: input,
    });
    return {
      country: saved.country,
      category: saved.category,
      area: saved.area,
      isRequiredToFile: saved.isRequiredToFile,
      tinMasked: saved.tinMasked,
    };
  }

  /* ------------------------------------------------------------------ */
  /* The regime                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * The highest version of a country's rules for a year, or nothing.
   *
   * Highest rather than latest-by-date: a correction is a new version, and
   * version order is the order somebody intended. Two rows written a second
   * apart have no meaningful `updatedAt` order and an obvious `version` one.
   */
  private async regimeRow(country: string, fiscalYear: string) {
    return this.prisma.taxRegime.findFirst({
      where: { country, fiscalYear },
      orderBy: { version: 'desc' },
    });
  }

  /**
   * The year's rules as the calculator needs them, or the sentence that says why
   * there are none.
   *
   * Three distinct refusals, and they are worth telling apart on the screen: a
   * year nobody has entered, a year entered but unchecked, and a year marked
   * checked whose figures do not parse. The third should never happen and is the
   * one that would otherwise crash mid-arithmetic.
   */
  private async loadRegime(
    country: string,
    fiscalYear: string,
  ): Promise<{ status: RegimeStatus; regime: TaxRegime | null }> {
    const row = await this.regimeRow(country, fiscalYear);

    const base: RegimeStatus = {
      country,
      fiscalYear,
      version: row?.version ?? null,
      found: row !== null,
      verified: false,
      citation: row?.sourceCitation ?? null,
      verifiedAt: row?.verifiedAt ? row.verifiedAt.toISOString() : null,
      verifiedByName: row?.verifiedByName ?? null,
      refusal: null,
      categories: [],
      areas: [],
    };

    if (!row) {
      return {
        status: {
          ...base,
          refusal: `${fiscalYear} অর্থবছরের করহার এখনো এই অ্যাপে যোগ করা হয়নি, তাই কোনো হিসাব দেখানো হচ্ছে না।`,
        },
        regime: null,
      };
    }

    if (!row.verified) {
      return {
        status: {
          ...base,
          refusal: `${fiscalYear} অর্থবছরের করহার এখনো যাচাই করা হয়নি, তাই কোনো হিসাব দেখানো হচ্ছে না। গেজেট মিলিয়ে হার যাচাই হলে এখানেই হিসাব দেখা যাবে।`,
        },
        regime: null,
      };
    }

    const figures = regimeFiguresSchema.safeParse({
      slabs: row.slabs,
      thresholdByCategory: row.thresholdByCategory,
      rebate: row.rebate,
      minimumTaxByArea: row.minimumTaxByArea,
      surchargeBands: row.surchargeBands ?? [],
    });

    if (!figures.success) {
      /* Loud, because this is a data fault in a table that decides what somebody
         pays, and the person on the screen cannot fix it. */
      this.logger.error(
        `TaxRegime ${row.id} is marked verified but its figures do not parse: ${figures.error.message}`,
      );
      return {
        status: {
          ...base,
          refusal: `${fiscalYear} অর্থবছরের করহারের তথ্য সম্পূর্ণ নয়, তাই হিসাব দেখানো হচ্ছে না।`,
        },
        regime: null,
      };
    }

    return {
      status: {
        ...base,
        verified: true,
        categories: Object.keys(figures.data.thresholdByCategory),
        areas: Object.keys(figures.data.minimumTaxByArea),
      },
      regime: {
        country: row.country,
        fiscalYearStart: row.fiscalYearStart,
        fiscalYearEnd: row.fiscalYearEnd,
        ...figures.data,
        sourceCitation: row.sourceCitation,
        verified: true,
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* The inputs                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Income by head for the window, with the categories behind each head.
   *
   * The same shape of query the income statement uses: every income entry in
   * this product credits the one hidden nominal income account, so grouping that
   * account's entries by category is the whole of "income by category" without
   * a join or a guess about transaction types.
   */
  private async incomeByHead(
    ctx: TenantContext,
    from: string,
    to: string,
  ): Promise<IncomeHeadLine[]> {
    const system = await this.accounts.systemAccounts(ctx.workspaceId);

    const grouped = await this.prisma.ledgerEntry.groupBy({
      by: ['categoryId'],
      where: {
        workspaceId: ctx.workspaceId,
        accountId: system.incomeAccountId,
        transaction: {
          deletedAt: null,
          /* Half-open, so the last day of June is included exactly once and a
             transaction timed at 23:30 on 30 June does not fall out of the
             year it belongs to. */
          date: {
            gte: fromLocalDateString(from, ctx.timezone),
            lt: fromLocalDateString(nextDateKey(to), ctx.timezone),
          },
        },
      },
      _sum: { amountMinor: true },
    });

    /* Deleted categories included on purpose. A year is long enough for somebody
       to have tidied up a category that still has income under it, and naming
       that money "unknown" on a tax worksheet helps nobody. */
    const cats = await this.prisma.category.findMany({
      where: { workspaceId: ctx.workspaceId },
      select: { id: true, name: true, nameBn: true },
    });
    const byId = new Map(cats.map((c) => [c.id, c]));

    const heads = new Map<HeadOfIncome, IncomeHeadLine>();
    for (const key of Object.keys(HEADS_OF_INCOME) as HeadOfIncome[]) {
      heads.set(key, { head: key, label: HEADS_OF_INCOME[key], amountMinor: 0, sources: [] });
    }

    for (const row of grouped) {
      const amountMinor = minorToNumber(row._sum.amountMinor ?? 0n);
      if (amountMinor === 0) continue;

      const category = row.categoryId ? byId.get(row.categoryId) : undefined;
      const matched = category ? matchHead(category) : undefined;
      const head = matched ?? FALLBACK_HEAD;
      const line = heads.get(head);
      if (!line) continue;

      line.amountMinor += amountMinor;
      line.sources.push({
        categoryId: row.categoryId,
        name: category ? displayName(category, ctx.locale) : 'খাতবিহীন',
        amountMinor,
        mapped: matched !== undefined,
      });
    }

    return [...heads.values()]
      .filter((line) => line.sources.length > 0)
      .map((line) => ({
        ...line,
        sources: [...line.sources].sort((a, b) => b.amountMinor - a.amountMinor),
      }));
  }

  /**
   * What was actually paid into savings and insurance inside the window.
   *
   * Paid, not due. An instalment that fell due in March and has not been paid is
   * not an investment, and a rebate claimed on it would be a rebate on money
   * that never left the account.
   *
   * A savings instalment contributes `expectedMinor` because that is the only
   * amount the row carries — the schedule's figure, marked paid. A premium
   * contributes `amountMinor`, which the payment screen lets somebody correct to
   * what the insurer actually took. Where the two differ, the second is the
   * better number, and it is the one used.
   */
  private async investments(
    ctx: TenantContext,
    from: string,
    to: string,
  ): Promise<InvestmentLine[]> {
    const paidWindow = {
      gte: fromLocalDateString(from, ctx.timezone),
      lt: fromLocalDateString(nextDateKey(to), ctx.timezone),
    };

    const [instalments, premiums] = await Promise.all([
      this.prisma.savingsInstallment.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          status: 'PAID',
          paidDate: paidWindow,
          plan: { deletedAt: null },
        },
        select: {
          expectedMinor: true,
          plan: { select: { id: true, planName: true, planType: true, institution: true } },
        },
      }),
      this.prisma.premiumPayment.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          status: 'PAID',
          paidDate: paidWindow,
          policy: { deletedAt: null },
        },
        select: {
          amountMinor: true,
          policy: { select: { id: true, insurer: true, policyType: true } },
        },
      }),
    ]);

    const lines = new Map<string, InvestmentLine>();

    for (const row of instalments) {
      const counted = REBATE_ELIGIBLE_PLAN_TYPES.has(row.plan.planType);
      const line = lines.get(`s:${row.plan.id}`) ?? {
        kind: 'SAVINGS' as const,
        id: row.plan.id,
        name: row.plan.planName,
        detail: row.plan.institution ?? row.plan.planType,
        paidMinor: 0,
        payments: 0,
        counted,
        note: counted ? null : NOT_COUNTED_REASON,
      };
      line.paidMinor += minorToNumber(row.expectedMinor);
      line.payments += 1;
      lines.set(`s:${row.plan.id}`, line);
    }

    for (const row of premiums) {
      /* Life insurance premium is named in §3.2 as eligible, so a policy on the
         books counts. Which policies qualify in law is narrower than "any
         policy" — hence the limits note, and hence a practitioner. */
      const line = lines.get(`i:${row.policy.id}`) ?? {
        kind: 'INSURANCE' as const,
        id: row.policy.id,
        name: row.policy.insurer,
        detail: row.policy.policyType,
        paidMinor: 0,
        payments: 0,
        counted: true,
        note: null,
      };
      line.paidMinor += minorToNumber(row.amountMinor);
      line.payments += 1;
      lines.set(`i:${row.policy.id}`, line);
    }

    return [...lines.values()].sort((a, b) => b.paidMinor - a.paidMinor);
  }

  /**
   * Assets less liabilities on the last day of the year, for the surcharge.
   *
   * At the year end and not today, because the surcharge is charged on net
   * wealth as at the close of the income year, and a house bought in September
   * has no business in the year that ended in June.
   *
   * Accounts kept in another currency are left out, exactly as
   * `AccountsService.position` leaves them out and for the same reason: nothing
   * in this product converts, and adding `USD 500` to a taka total as five
   * hundred would be a silent error inside a tax figure.
   */
  private async netWealthAt(workspaceId: string, asOf: string, timezone: string): Promise<number> {
    const [workspace, accounts, balances] = await Promise.all([
      this.prisma.workspace.findUniqueOrThrow({
        where: { id: workspaceId },
        select: { currency: true },
      }),
      this.prisma.account.findMany({
        where: { workspaceId, deletedAt: null },
        select: { id: true, name: true, type: true, currency: true, systemKey: true },
      }),
      this.accounts.balances(workspaceId, fromLocalDateString(nextDateKey(asOf), timezone)),
    ]);

    const home = workspace.currency.toUpperCase();
    const inBooks = accounts.filter(
      (a) => a.systemKey !== null || a.currency.toUpperCase() === home,
    );

    return buildBalanceSheet(inBooks.map((a) => ({ ...a, balanceMinor: balances.get(a.id) ?? 0 })))
      .netWorthMinor;
  }

  /* ------------------------------------------------------------------ */
  /* The two things the controller calls                                 */
  /* ------------------------------------------------------------------ */

  /**
   * The sheet and the year's rules together, read once.
   *
   * One method because `estimate` needs both and reading the regime twice would
   * leave a window — small, but real — where the row is verified for the
   * worksheet's copy of the status and something else by the time the figure is
   * computed from it. The status a caller is shown and the rates a figure came
   * from are the same read.
   */
  private async build(
    ctx: TenantContext,
    fiscalYear?: string,
  ): Promise<{ worksheet: TaxWorksheet; regime: TaxRegime | null }> {
    const profile = await this.profile(ctx.workspaceId);
    const year = fiscalYear ?? this.currentFiscalYear(ctx.timezone);
    const { from, to } = fiscalYearRange(year);

    const [{ status, regime }, heads, investments, netWealthMinor] = await Promise.all([
      this.loadRegime(profile.country, year),
      this.incomeByHead(ctx, from, to),
      this.investments(ctx, from, to),
      this.netWealthAt(ctx.workspaceId, to, ctx.timezone),
    ]);

    return {
      regime,
      worksheet: {
        fiscalYear: year,
        from,
        to,
        regime: status,
        profile,
        totalIncomeMinor: heads.reduce((sum, head) => sum + head.amountMinor, 0),
        heads,
        eligibleInvestmentMinor: investments
          .filter((line) => line.counted)
          .reduce((sum, line) => sum + line.paidMinor, 0),
        investments,
        netWealthMinor,
        /* Zero, and said out loud in `limits`. §3.3: TDS is a transaction the
           person already records when a bank credits interest net of tax —
           provided there is a category for it, which there is not yet. Inferring
           it from anything else would be inventing a figure. */
        taxDeductedAtSourceMinor: 0,
        limits: [...WORKSHEET_LIMITS],
      },
    };
  }

  /**
   * Every input, traced, and no tax.
   *
   * Never refuses. A year whose rates nobody has checked still has income in it,
   * and the sheet of income is worth having on its own — it is the part somebody
   * takes to their practitioner, and it is where a miscategorised salary gets
   * noticed.
   */
  async worksheet(ctx: TenantContext, fiscalYear?: string): Promise<TaxWorksheet> {
    const { worksheet } = await this.build(ctx, fiscalYear);
    return worksheet;
  }

  /**
   * The figure, once — and only from a year somebody has checked.
   *
   * A workspace with no income at all gets zero rather than an error: nothing
   * recorded is a fact about the books, not a failure, and somebody required to
   * file in a year they earned nothing needs exactly this sheet.
   */
  async estimate(ctx: TenantContext, fiscalYear?: string): Promise<TaxEstimateResult> {
    const { worksheet, regime } = await this.build(ctx, fiscalYear);

    if (!regime) {
      throw new UnprocessableEntityException({
        message:
          worksheet.regime.refusal ??
          'এই অর্থবছরের করহার যাচাই করা হয়নি, তাই হিসাব দেখানো হচ্ছে না।',
        code: 'TAX_REGIME_UNVERIFIED',
        fiscalYear: worksheet.fiscalYear,
      });
    }

    try {
      const estimate = estimateTax(
        {
          incomeByHead: Object.fromEntries(
            worksheet.heads.map((head) => [head.head, head.amountMinor]),
          ),
          eligibleInvestmentMinor: worksheet.eligibleInvestmentMinor,
          netWealthMinor: worksheet.netWealthMinor,
          taxDeductedAtSourceMinor: worksheet.taxDeductedAtSourceMinor,
          category: worksheet.profile.category,
          area: worksheet.profile.area,
        },
        regime,
      );

      return {
        worksheet,
        estimate,
        rebateBoundBy: estimate.lines.find((line) => line.key === 'rebate')?.note ?? 'investment',
      };
    } catch (err) {
      /* The core's own refusals — an unverified regime that slipped past the
         check above, a taxpayer category or an area the year does not define —
         arrive as Bengali sentences already. They are passed through rather than
         rephrased, and they become a 422 rather than a 500 because there is
         nothing wrong with the request: the app simply will not answer it. */
      if (err instanceof TaxRegimeMissingError) {
        throw new UnprocessableEntityException({
          message: err.message,
          code: 'TAX_REGIME_UNVERIFIED',
          fiscalYear: worksheet.fiscalYear,
        });
      }
      throw err;
    }
  }
}

/** The head a category answers to, by either of its names. */
function matchHead(category: { name: string; nameBn: string | null }): HeadOfIncome | undefined {
  const byBn = category.nameBn ? HEAD_BY_CATEGORY_NAME[category.nameBn.trim()] : undefined;
  return byBn ?? HEAD_BY_CATEGORY_NAME[category.name.trim().toLowerCase()];
}
