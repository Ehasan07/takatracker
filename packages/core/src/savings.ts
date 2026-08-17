import { sumMinor } from '@hishab/shared';

/**
 * DPS, FDR and Sanchayapatra projections.
 *
 * Two rules, both from docs/PLAN.md §6:
 *
 *  1. **The user types the rate.** Banks advertise wildly different profit
 *     rates and change them yearly; inferring one would produce a number the
 *     customer cannot reconcile against their own passbook.
 *  2. **Tax and AIT are not modelled.** Excise duty and AIT vary by balance
 *     band and by year, and quietly applying the wrong deduction is worse than
 *     showing the gross figure. Every projection is labelled as before tax.
 *
 * Rates are basis points (825 = 8.25%) so the input stays an integer, and every
 * amount is integer poisha. The formula is returned alongside the number so the
 * UI can show its working — a projection nobody can check is worth nothing.
 */

export type ProfitCalc = 'SIMPLE' | 'COMPOUND_MONTHLY' | 'COMPOUND_QUARTERLY' | 'COMPOUND_YEARLY';
export type PlanFrequency = 'MONTHLY' | 'QUARTERLY' | 'HALF_YEARLY' | 'YEARLY';

export const MONTHS_PER_PERIOD: Record<PlanFrequency, number> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  HALF_YEARLY: 6,
  YEARLY: 12,
};

export const COMPOUNDS_PER_YEAR: Record<ProfitCalc, number> = {
  SIMPLE: 0,
  COMPOUND_MONTHLY: 12,
  COMPOUND_QUARTERLY: 4,
  COMPOUND_YEARLY: 1,
};

export interface SavingsPlanInput {
  /** Recurring deposit per instalment, poisha. Zero for a lump-sum FDR. */
  installmentMinor: number;
  /** Lump sum placed at the start, poisha. Zero for a plain DPS. */
  principalMinor: number;
  frequency: PlanFrequency;
  termMonths: number;
  /** Annual rate in basis points: 8.25% is 825. */
  profitRateBps: number;
  profitCalc: ProfitCalc;
}

export interface SavingsProjection {
  /** How many instalments the term contains. */
  installmentCount: number;
  /** Everything the saver puts in, principal plus instalments. */
  depositedMinor: number;
  /** Gross profit, before any tax or excise duty. */
  profitMinor: number;
  /** Deposited + profit, before tax. */
  maturityMinor: number;
  /** Plain-language description of exactly what was computed. */
  formula: string;
}

/** Poisha in, poisha out: never let a fractional poisha into a money value. */
function toMinor(value: number): number {
  return Math.trunc(value);
}

/**
 * Compound a single lump sum: A = P(1 + r/n)^(n·t).
 * With `SIMPLE`, A = P(1 + r·t).
 */
export function growLumpSum(
  principalMinor: number,
  profitRateBps: number,
  months: number,
  profitCalc: ProfitCalc,
): number {
  if (principalMinor <= 0 || months <= 0 || profitRateBps <= 0) return principalMinor;

  const rate = profitRateBps / 10_000;
  const years = months / 12;

  if (profitCalc === 'SIMPLE') return toMinor(principalMinor * (1 + rate * years));

  const n = COMPOUNDS_PER_YEAR[profitCalc];
  return toMinor(principalMinor * (1 + rate / n) ** (n * years));
}

/**
 * Project a savings plan to maturity.
 *
 * Each instalment is grown for the time it is actually on deposit, which is
 * what a bank does — the first instalment earns for the whole term, the last
 * for almost none. Treating the whole contributed sum as if it sat there from
 * day one is the common mistake, and it overstates maturity badly on a long DPS.
 */
export function projectSavings(plan: SavingsPlanInput): SavingsProjection {
  const monthsPerPeriod = MONTHS_PER_PERIOD[plan.frequency];
  const installmentCount =
    plan.installmentMinor > 0 ? Math.floor(plan.termMonths / monthsPerPeriod) : 0;

  const contributions: number[] = [];
  for (let i = 0; i < installmentCount; i += 1) {
    const monthsOnDeposit = plan.termMonths - i * monthsPerPeriod;
    contributions.push(
      growLumpSum(plan.installmentMinor, plan.profitRateBps, monthsOnDeposit, plan.profitCalc),
    );
  }

  const grownPrincipal = growLumpSum(
    plan.principalMinor,
    plan.profitRateBps,
    plan.termMonths,
    plan.profitCalc,
  );

  const maturityMinor = sumMinor([grownPrincipal, ...contributions]);
  const depositedMinor = plan.principalMinor + plan.installmentMinor * installmentCount;

  const ratePercent = (plan.profitRateBps / 100).toFixed(2);
  const formula =
    plan.profitCalc === 'SIMPLE'
      ? `প্রতিটি জমা তার নিজের সময়ের জন্য সরল হারে: A = P × (1 + ${ratePercent}% × বছর)। কর কাটার আগের হিসাব।`
      : `প্রতিটি জমা তার নিজের সময়ের জন্য চক্রবৃদ্ধি: A = P × (1 + ${ratePercent}%/${COMPOUNDS_PER_YEAR[plan.profitCalc]})^(${COMPOUNDS_PER_YEAR[plan.profitCalc]} × বছর)। কর কাটার আগের হিসাব।`;

  return {
    installmentCount,
    depositedMinor,
    profitMinor: maturityMinor - depositedMinor,
    maturityMinor,
    formula,
  };
}

export interface InstalmentPlanRow {
  index: number;
  /** Months after the start date. */
  monthOffset: number;
  expectedMinor: number;
}

/** The instalment schedule a DPS should follow, for generating rows to tick off. */
export function buildInstalmentSchedule(plan: SavingsPlanInput): InstalmentPlanRow[] {
  if (plan.installmentMinor <= 0) return [];
  const monthsPerPeriod = MONTHS_PER_PERIOD[plan.frequency];
  const count = Math.floor(plan.termMonths / monthsPerPeriod);

  return Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    monthOffset: i * monthsPerPeriod,
    expectedMinor: plan.installmentMinor,
  }));
}

export interface SavingsProgress {
  paidCount: number;
  missedCount: number;
  remainingCount: number;
  paidMinor: number;
  /** 0–100, for a progress ring. */
  percentComplete: number;
}

/**
 * How far along a plan is.
 *
 * ## Two kinds of instrument, two honest answers
 *
 * A DPS is measured by **instalments paid**: the saver's job is a payment every
 * month, and the fraction of them made is exactly how far through they are.
 * Time elapsed would be the wrong measure there — somebody who skipped three
 * months is not as far along as somebody who did not, and a ring driven by the
 * calendar would say they were.
 *
 * An FDR or a Sanchayapatra has no instalments at all. The money went in once,
 * on the first day, and the only thing that changes afterwards is the calendar.
 * So for those, **time toward maturity is the progress** — and it is not a
 * guess, because there is nothing left to pay that could fail to happen.
 *
 * Returning zero for a lump sum, which is what this did before, made every FDR
 * read 0% forever: an instrument that could never move, on a screen whose whole
 * job is to say how far along things are.
 *
 * `span` is optional so the DPS path is untouched — with no dates supplied a
 * plan with no instalments still reports zero, which is the only truthful
 * answer when nothing is known about its term.
 */
export function summariseProgress(
  rows: readonly { status: string; expectedMinor: number }[],
  span?: { startDate: Date; maturityDate: Date | null; today?: Date },
): SavingsProgress {
  const paid = rows.filter((r) => r.status === 'PAID');
  const missed = rows.filter((r) => r.status === 'MISSED');
  const total = rows.length;

  if (total === 0) {
    const maturity = span?.maturityDate;
    if (!span || !maturity) {
      return { paidCount: 0, missedCount: 0, remainingCount: 0, paidMinor: 0, percentComplete: 0 };
    }
    const start = span.startDate.getTime();
    const end = maturity.getTime();
    const now = (span.today ?? new Date()).getTime();
    /* A term that ends before it starts is bad data, not a 0% plan; refuse to
       divide by it rather than report a figure derived from nonsense. */
    const elapsed = end <= start ? 0 : Math.min(1, Math.max(0, (now - start) / (end - start)));
    return {
      paidCount: 0,
      missedCount: 0,
      remainingCount: 0,
      paidMinor: 0,
      percentComplete: Math.floor(elapsed * 1000 + 0.5) / 10,
    };
  }

  return {
    paidCount: paid.length,
    missedCount: missed.length,
    remainingCount: total - paid.length,
    paidMinor: sumMinor(paid.map((r) => r.expectedMinor)),
    percentComplete: Math.floor((paid.length / total) * 1000 + 0.5) / 10,
  };
}
