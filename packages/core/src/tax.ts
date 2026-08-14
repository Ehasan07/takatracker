import { sumMinor } from '@hishab/shared';

/**
 * An income tax estimate, computed from a rate table rather than from code.
 *
 * ## The one decision everything else follows from
 *
 * **No rate, threshold, cap or band appears in this file.** They all arrive in a
 * `TaxRegime`, which is a row somebody entered for one country and one fiscal
 * year and then ticked to say they had checked it against the gazette.
 *
 * The reason is not flexibility. It is that Bangladesh's Finance Act changes the
 * slabs, the tax-free threshold, the rebate caps and the surcharge bands most
 * years, and a number compiled into a release is a number that goes on being
 * used after it stops being true — silently, because a tax figure computed on
 * last year's slabs looks exactly like one computed on this year's. Nobody
 * carrying it to their accountant can tell. Making the rates data means an
 * out-of-date year has *no* row, and no row means no estimate.
 *
 * ## What this file is and is not
 *
 * It is arithmetic: given income by head, investments, wealth and a regime,
 * produce a figure and show every step. It is pure — no database, no clock, no
 * locale — so the whole thing can be checked against worked examples.
 *
 * It is not a tax return, and the product must never call it one. The estimate
 * is only as good as what somebody recorded: cash income nobody typed is
 * invisible and the number will be confidently low. That is why
 * `TaxEstimate.lines` exists — every figure carries where it came from, so the
 * person can see what the app knew rather than being handed a total to trust.
 *
 * ## Money
 *
 * Integer poisha throughout, like everywhere else in this system. Tax
 * arithmetic multiplies by rates, so rates are held in **basis points** — 10%
 * is 1000 — and every product is floored to whole poisha with integer maths.
 * Floating point has no place between somebody's salary and what they owe.
 */

/** A slab: everything above `fromMinor` up to the next band, at `rateBps`. */
export interface TaxSlab {
  /** Lower bound of the band, inclusive, in poisha. The first is the threshold. */
  fromMinor: number;
  /** Basis points. 10% is 1000, 25% is 2500. */
  rateBps: number;
}

/**
 * The rebate on eligible investment.
 *
 * Bangladesh computes it as the lowest of several caps rather than a flat
 * percentage, which is why this is three numbers and not one.
 */
export interface RebateRule {
  /** Share of eligible investment that can be claimed. */
  rateOfInvestmentBps: number;
  /** …but never more than this share of taxable income. */
  capShareOfIncomeBps: number;
  /** …and never more than this absolute amount, in poisha. */
  capAbsoluteMinor: number;
}

export interface SurchargeBand {
  /** Net wealth above which this band applies, in poisha. */
  fromMinor: number;
  rateBps: number;
}

/**
 * One country, one fiscal year, as somebody transcribed it from the Act.
 *
 * `verified` is not decoration. Nothing computes without it — see
 * `estimateTax`, which refuses rather than guessing.
 */
export interface TaxRegime {
  country: string;
  /** `YYYY-MM-DD`, inclusive. Bangladesh runs July to June. */
  fiscalYearStart: string;
  fiscalYearEnd: string;
  /** Slabs for the general taxpayer, ascending by `fromMinor`. */
  slabs: TaxSlab[];
  /**
   * The tax-free threshold, by taxpayer category.
   *
   * A separate map rather than a separate slab table, because only the first
   * boundary moves: a woman over 65 pays the same rates on the same bands as
   * everybody else, starting further up.
   */
  thresholdByCategory: Record<string, number>;
  rebate: RebateRule;
  /** Payable even at a loss, by where the taxpayer lives. */
  minimumTaxByArea: Record<string, number>;
  surchargeBands: SurchargeBand[];
  /** "Finance Act 2025" — printed beside every figure this produces. */
  sourceCitation: string;
  /** False until a person has checked this row against the gazette. */
  verified: boolean;
}

/** What the ledger contributes, already bucketed to the fiscal year. */
export interface TaxInputs {
  /** Income by head, in poisha. Keys are the heads of income. */
  incomeByHead: Record<string, number>;
  /** Investment eligible for the rebate — DPS, premiums, certificates. */
  eligibleInvestmentMinor: number;
  /** Net wealth at year end, for the surcharge. Negative is treated as zero. */
  netWealthMinor: number;
  /** Tax already deducted at source, subtracted at the end. */
  taxDeductedAtSourceMinor: number;
  /** Which threshold applies. Must be a key of `thresholdByCategory`. */
  category: string;
  /** Which minimum tax applies. Must be a key of `minimumTaxByArea`. */
  area: string;
}

/** One line of the worksheet: a label, a figure, and where it came from. */
export interface TaxLine {
  key: string;
  amountMinor: number;
  /** The rate applied, when one was. Basis points. */
  rateBps?: number;
  /** Free text naming the source — a head of income, a cap, a band. */
  note?: string;
}

export interface TaxEstimate {
  totalIncomeMinor: number;
  taxableIncomeMinor: number;
  /** Before rebate, before minimum tax, before surcharge. */
  grossTaxMinor: number;
  rebateMinor: number;
  /** After rebate, before the minimum-tax floor. */
  netTaxMinor: number;
  minimumTaxMinor: number;
  surchargeMinor: number;
  /** What the estimate says is payable, after tax already deducted. */
  payableMinor: number;
  /** Every step, in order, for a worksheet that shows its working. */
  lines: TaxLine[];
  citation: string;
}

/** Thrown rather than returned: a missing regime is not a zero, it is a refusal. */
export class TaxRegimeMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaxRegimeMissingError';
  }
}

/**
 * Apply a basis-point rate to an integer amount, flooring to whole poisha.
 *
 * Integer maths on purpose. `amount * 0.15` is a float and a float in a tax
 * computation is a rounding argument waiting to happen; `(amount * 1500) /
 * 10000` with a floor is the same sum and cannot drift.
 */
function applyBps(amountMinor: number, rateBps: number): number {
  return Math.floor((amountMinor * rateBps) / 10_000);
}

/**
 * Tax on an amount, band by band.
 *
 * The first slab's `fromMinor` is the tax-free threshold and is replaced by the
 * category's own — that is the only thing a category changes.
 */
export function taxBySlabs(
  taxableMinor: number,
  slabs: readonly TaxSlab[],
  thresholdMinor: number,
): { totalMinor: number; lines: TaxLine[] } {
  if (taxableMinor <= thresholdMinor) {
    return { totalMinor: 0, lines: [] };
  }

  const ordered = [...slabs].sort((a, b) => a.fromMinor - b.fromMinor);
  const lines: TaxLine[] = [];
  let total = 0;

  for (let i = 0; i < ordered.length; i += 1) {
    const band = ordered[i]!;
    /* The first band starts at the taxpayer's own threshold, not the table's:
       the table is written for the general taxpayer and a woman over 65 starts
       higher up the same ladder. */
    const from = i === 0 ? thresholdMinor : Math.max(band.fromMinor, thresholdMinor);
    const next = ordered[i + 1];
    const to = next ? Math.max(next.fromMinor, thresholdMinor) : Number.POSITIVE_INFINITY;

    if (taxableMinor <= from) break;

    const inBand = Math.min(taxableMinor, to) - from;
    if (inBand <= 0) continue;

    const tax = applyBps(inBand, band.rateBps);
    total += tax;
    lines.push({
      key: `slab.${band.rateBps}`,
      amountMinor: tax,
      rateBps: band.rateBps,
      note: `${from}–${next ? to : ''}`,
    });
  }

  return { totalMinor: total, lines };
}

/**
 * The investment rebate: the lowest of three caps.
 *
 * Written as three explicit candidates rather than a nested `Math.min`, because
 * which cap bound the answer is a thing the worksheet should be able to say.
 */
export function rebateFor(
  taxableIncomeMinor: number,
  eligibleInvestmentMinor: number,
  rule: RebateRule,
): { amountMinor: number; boundBy: string } {
  const byInvestment = applyBps(eligibleInvestmentMinor, rule.rateOfInvestmentBps);
  const byIncome = applyBps(taxableIncomeMinor, rule.capShareOfIncomeBps);
  const byAbsolute = rule.capAbsoluteMinor;

  const lowest = Math.min(byInvestment, byIncome, byAbsolute);
  const boundBy =
    lowest === byInvestment ? 'investment' : lowest === byIncome ? 'income' : 'absolute';

  return { amountMinor: Math.max(0, lowest), boundBy };
}

/** The surcharge band net wealth falls into. Zero when it falls below them all. */
export function surchargeFor(
  netWealthMinor: number,
  taxMinor: number,
  bands: readonly SurchargeBand[],
): { amountMinor: number; rateBps: number } {
  if (netWealthMinor <= 0 || bands.length === 0) return { amountMinor: 0, rateBps: 0 };

  const applicable = [...bands]
    .sort((a, b) => a.fromMinor - b.fromMinor)
    .filter((band) => netWealthMinor > band.fromMinor)
    .at(-1);

  if (!applicable) return { amountMinor: 0, rateBps: 0 };
  return { amountMinor: applyBps(taxMinor, applicable.rateBps), rateBps: applicable.rateBps };
}

/**
 * The whole estimate.
 *
 * Refuses outright when the regime is unverified. That is the single most
 * important line in this file: a figure computed from numbers nobody checked is
 * worse than no figure, because it will be believed.
 */
export function estimateTax(inputs: TaxInputs, regime: TaxRegime): TaxEstimate {
  if (!regime.verified) {
    throw new TaxRegimeMissingError(
      'এই অর্থবছরের করহার এখনো যাচাই করা হয়নি, তাই হিসাব দেখানো হচ্ছে না।',
    );
  }

  const threshold = regime.thresholdByCategory[inputs.category];
  if (threshold === undefined) {
    throw new TaxRegimeMissingError(`করদাতার শ্রেণি চেনা যায়নি: ${inputs.category}`);
  }

  const minimumTax = regime.minimumTaxByArea[inputs.area];
  if (minimumTax === undefined) {
    throw new TaxRegimeMissingError(`এলাকা চেনা যায়নি: ${inputs.area}`);
  }

  const lines: TaxLine[] = [];

  /* Income, head by head, so a wrong total can be traced to the head that is
     wrong rather than argued about as a whole. */
  const heads = Object.entries(inputs.incomeByHead).filter(([, amount]) => amount !== 0);
  for (const [head, amount] of heads) {
    lines.push({ key: `income.${head}`, amountMinor: amount, note: head });
  }
  const totalIncome = sumMinor(heads.map(([, amount]) => amount));

  /* No deductions modelled yet — see the report. Taxable income is total
     income, and the day exemptions arrive they belong between these two lines
     and nowhere else. */
  const taxableIncome = Math.max(0, totalIncome);
  lines.push({ key: 'taxableIncome', amountMinor: taxableIncome });
  lines.push({ key: 'threshold', amountMinor: threshold, note: inputs.category });

  const slabResult = taxBySlabs(taxableIncome, regime.slabs, threshold);
  lines.push(...slabResult.lines);
  const grossTax = slabResult.totalMinor;
  lines.push({ key: 'grossTax', amountMinor: grossTax });

  const rebate = rebateFor(taxableIncome, inputs.eligibleInvestmentMinor, regime.rebate);
  lines.push({
    key: 'rebate',
    amountMinor: -rebate.amountMinor,
    note: rebate.boundBy,
  });

  /* Never below zero: a rebate larger than the tax is not a refund. */
  const netTax = Math.max(0, grossTax - rebate.amountMinor);

  /* The floor. Somebody required to file pays it in a year they earned nothing,
     which is why it is a maximum against the computed figure and not an
     addition to it. */
  const afterMinimum = Math.max(netTax, taxableIncome > threshold ? minimumTax : netTax);
  if (afterMinimum !== netTax) {
    lines.push({ key: 'minimumTax', amountMinor: minimumTax, note: inputs.area });
  }

  const surcharge = surchargeFor(
    Math.max(0, inputs.netWealthMinor),
    afterMinimum,
    regime.surchargeBands,
  );
  if (surcharge.amountMinor > 0) {
    lines.push({
      key: 'surcharge',
      amountMinor: surcharge.amountMinor,
      rateBps: surcharge.rateBps,
    });
  }

  const beforeCredits = afterMinimum + surcharge.amountMinor;
  if (inputs.taxDeductedAtSourceMinor > 0) {
    lines.push({ key: 'tds', amountMinor: -inputs.taxDeductedAtSourceMinor });
  }

  /* Can go negative, and is left that way on purpose: somebody over-deducted at
     source is owed a refund, and showing that as zero would hide it. */
  const payable = beforeCredits - inputs.taxDeductedAtSourceMinor;
  lines.push({ key: 'payable', amountMinor: payable });

  return {
    totalIncomeMinor: totalIncome,
    taxableIncomeMinor: taxableIncome,
    grossTaxMinor: grossTax,
    rebateMinor: rebate.amountMinor,
    netTaxMinor: netTax,
    minimumTaxMinor: afterMinimum !== netTax ? minimumTax : 0,
    surchargeMinor: surcharge.amountMinor,
    payableMinor: payable,
    lines,
    citation: regime.sourceCitation,
  };
}

/**
 * The fiscal year a date falls in, as `YYYY-YY`.
 *
 * Bangladesh runs July to June, so 15 August 2026 is in 2026-27 and 15 May 2026
 * is in 2025-26. The month the year turns over is a parameter because this will
 * be wrong for the second country and right for it too.
 */
export function fiscalYearOf(isoDate: string, startMonth = 7): string {
  const [year, month] = isoDate.split('-').map(Number) as [number, number];
  const startYear = month >= startMonth ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** The inclusive date bounds of a fiscal year named by `fiscalYearOf`. */
export function fiscalYearRange(fiscalYear: string, startMonth = 7): { from: string; to: string } {
  const startYear = Number(fiscalYear.split('-')[0]);
  const mm = String(startMonth).padStart(2, '0');
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  const endYear = startMonth === 1 ? startYear : startYear + 1;
  /* The last day of the month before it starts again. `new Date(y, m, 0)` is
     the last day of month `m`, which is the one arithmetic that has to be right
     here and is easy to get wrong by hand in February. */
  const lastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
  return {
    from: `${startYear}-${mm}-01`,
    to: `${endYear}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
  };
}
