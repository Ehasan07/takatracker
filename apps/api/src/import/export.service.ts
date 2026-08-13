import { Injectable, NotFoundException } from '@nestjs/common';
import { displayName, fromLocalDateString, toLocalDateString, type Locale } from '@hishab/shared';
import type { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { minorToNumber } from '../common/bigint-json';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../transactions/transactions.service';

/**
 * Taking your data out.
 *
 * Spec §9 promises the user can leave with everything they put in, so this is
 * deliberately not gated behind a plan: a CSV of your own transactions and a
 * JSON dump of your own workspace are not a premium feature, they are the
 * reason it is safe to type your money into somebody else's software. (There
 * is an `export.enabled` entitlement in the plan catalogue; if a future product
 * decision wants the *CSV* behind it, that is one `assertEnabled` call here —
 * but `/export/full` must stay open whatever happens to it.)
 *
 * Two details that are not decoration:
 *
 *  1. **The BOM.** Excel on a Bengali Windows install reads a CSV as the system
 *     code page unless the file begins with a UTF-8 byte order mark. Without it
 *     "কাঁচাবাজার" opens as mojibake and the user concludes the export is
 *     broken. Three bytes; nothing else fixes it.
 *  2. **The formula guard.** A field beginning `=`, `+`, `-` or `@` is a live
 *     formula to Excel and to Sheets, and a payee named `=cmd|'/c calc'!A1`
 *     turns an innocent download into code execution on the machine of whoever
 *     opens it. Every field gets an apostrophe in front when it starts with
 *     one of those, which those programs read as "this is text".
 *
 * Both exports emit `export.downloaded`.
 */

const BOM = '\uFEFF';

/**
 * The Bengali header row.
 *
 * These are exactly the names `guessMapping` in @hishab/core recognises, so an
 * export can be edited in a spreadsheet and imported straight back. An export
 * nobody can re-import is not really an export.
 */
/**
 * The column titles, in the language the books are kept in.
 *
 * Nine strings and the only ones in the file, so they are a table rather than a
 * catalogue key. An English workspace exporting to Excel and getting Bengali
 * headers over English category names is a file whose two halves disagree —
 * and a spreadsheet header is the one string a reader has to understand before
 * any of the numbers under it mean anything.
 */
const CSV_HEADERS: Record<Locale, readonly string[]> = {
  bn: ['তারিখ', 'বিবরণ', 'ক্যাটাগরি', 'অ্যাকাউন্ট', 'জমা', 'খরচ', 'রেফারেন্স', 'ধরন', 'মন্তব্য'],
  en: [
    'Date',
    'Description',
    'Category',
    'Account',
    'Credit',
    'Debit',
    'Reference',
    'Type',
    'Notes',
  ],
};

/**
 * Characters that make a spreadsheet treat a cell as a formula rather than as
 * text. Tab and carriage return are on the list because both are used to slip
 * past a naive check on the first character alone.
 */
const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];

/** Escape one CSV field: formula guard first, then quoting. */
function csvField(value: string | null | undefined): string {
  let text = value ?? '';
  const first = text.charAt(0);
  if (text !== '' && FORMULA_TRIGGERS.includes(first)) text = `'${text}`;
  if (/["\n\r,;\t]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

function csvLine(fields: readonly (string | null | undefined)[]): string {
  return fields.map(csvField).join(',');
}

/**
 * Poisha as a plain decimal: `18462.00`, never `18,46,200.00`.
 *
 * Integer arithmetic only — no float ever touches an amount, here or anywhere.
 * No grouping separators either: they are what a spreadsheet in a non-Indian
 * locale mis-reads, and `parseMoneyToMinor` reads the plain form back exactly.
 */
function takaPlain(minor: number): string {
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const major = Math.trunc(abs / 100);
  const fraction = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${major}.${fraction}`;
}

const txInclude = {
  entries: {
    include: {
      account: { select: { id: true, name: true, systemKey: true } },
      category: { select: { id: true, name: true, nameBn: true } },
    },
  },
} satisfies Prisma.TransactionInclude;

type TxWithEntries = Prisma.TransactionGetPayload<{ include: typeof txInclude }>;

export interface ExportQuery {
  from?: string;
  to?: string;
  accountId?: string;
}

export interface CsvExport {
  filename: string;
  /** Already carries the BOM. Send as-is with `text/csv; charset=utf-8`. */
  body: string;
  rowCount: number;
}

export interface JsonExport {
  filename: string;
  body: Record<string, unknown>;
}

@Injectable()
export class ExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The workspace's transactions as a CSV, oldest first — the way a statement
   * reads, and the order that makes a running balance meaningful if anyone adds
   * one in a spreadsheet.
   */
  async transactionsCsv(ctx: TenantContext, query: ExportQuery): Promise<CsvExport> {
    if (query.accountId) await this.requireAccount(ctx.workspaceId, query.accountId);

    const where: Prisma.TransactionWhereInput = {
      workspaceId: ctx.workspaceId,
      deletedAt: null,
      ...(query.from || query.to
        ? {
            date: {
              ...(query.from ? { gte: fromLocalDateString(query.from, ctx.timezone) } : {}),
              ...(query.to
                ? {
                    // Inclusive `to`: the day the user typed is inside the range.
                    lt: new Date(
                      fromLocalDateString(query.to, ctx.timezone).getTime() + 86_400_000,
                    ),
                  }
                : {}),
            },
          }
        : {}),
      ...(query.accountId ? { entries: { some: { accountId: query.accountId } } } : {}),
    };

    const rows = await this.prisma.transaction.findMany({
      where,
      include: txInclude,
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });

    const lines = [csvLine(CSV_HEADERS[ctx.locale])];
    for (const tx of rows) {
      lines.push(csvLine(ExportService.csvRow(tx, ctx.timezone, ctx.locale, query.accountId)));
    }

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: 'export.downloaded',
      entity: 'Transaction',
      after: {
        format: 'csv',
        rowCount: rows.length,
        from: query.from ?? null,
        to: query.to ?? null,
        accountId: query.accountId ?? null,
      },
    });

    return {
      filename: ExportService.csvFilename(query),
      // The BOM goes first or Excel reads the whole file as a legacy code page.
      body: BOM + lines.join('\r\n') + '\r\n',
      rowCount: rows.length,
    };
  }

  /**
   * One transaction as a row.
   *
   * The amount is signed from the point of view of the account being looked at:
   * with `accountId` set, that account's own leg decides; without one, the
   * first real (non-system) leg does, and a transfer is shown from the side the
   * money left. A flat CSV cannot say "these two rows are one transfer", so the
   * ধরন column carries the type and the reader can see it for what it is.
   */
  private static csvRow(
    tx: TxWithEntries,
    timezone: string,
    locale: Locale,
    accountId?: string,
  ): (string | null)[] {
    const real = tx.entries.filter((e) => !e.account.systemKey);

    const focus =
      (accountId ? real.find((e) => e.accountId === accountId) : undefined) ??
      (tx.type === 'TRANSFER' ? real.find((e) => e.direction === 'CREDIT') : undefined) ??
      real[0] ??
      tx.entries[0];

    const magnitude = focus ? minorToNumber(focus.amountMinor) : 0;
    const signed = focus?.direction === 'DEBIT' ? magnitude : -magnitude;

    const categorised = tx.entries.find((e) => e.category);

    return [
      toLocalDateString(tx.date, timezone),
      tx.description ?? tx.payee ?? '',
      categorised?.category ? displayName(categorised.category, locale) : '',
      focus?.account.name ?? '',
      signed > 0 ? takaPlain(signed) : '',
      signed < 0 ? takaPlain(-signed) : '',
      tx.externalRef ?? '',
      tx.type,
      tx.notes ?? '',
    ];
  }

  private static csvFilename(query: ExportQuery): string {
    const window = query.from || query.to ? `-${query.from ?? 'start'}_${query.to ?? 'end'}` : '';
    return `hishab-transactions${window}.csv`;
  }

  /**
   * Everything the workspace owns, as JSON.
   *
   * Spec §9 promises the user can take their data and leave; this is that
   * promise, and it is why it covers every table rather than the interesting
   * ones. Credentials are the single exception: password hashes, bot tokens,
   * invitation tokens and one-shot email tokens are secrets that happen to live
   * beside the data, and handing them out in a download would be a way of
   * leaking an account, not of returning it. A Telegram chat id is an address
   * rather than a secret and stays.
   */
  async full(ctx: TenantContext): Promise<JsonExport> {
    const workspaceId = ctx.workspaceId;

    const [
      workspace,
      accounts,
      categories,
      people,
      transactions,
      loans,
      loanPayments,
      savingsPlans,
      savingsInstallments,
      policies,
      premiums,
      importBatches,
      cardCycles,
      telegram,
      ingestionMessages,
      transactionDrafts,
      auditEvents,
    ] = await Promise.all([
      this.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: {
          id: true,
          name: true,
          status: true,
          currency: true,
          timezone: true,
          creditCardReminderLeadDays: true,
          autoMuteOnCardPayment: true,
          createdAt: true,
          plan: { select: { code: true, name: true } },
          memberships: {
            select: {
              role: true,
              status: true,
              joinedAt: true,
              user: { select: { id: true, name: true, email: true, locale: true } },
            },
          },
        },
      }),
      this.prisma.account.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.category.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.person.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.transaction.findMany({
        where: { workspaceId },
        include: { entries: true },
        orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.loan.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.loanPayment.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.savingsPlan.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.savingsInstallment.findMany({
        where: { workspaceId },
        orderBy: { dueDate: 'asc' },
      }),
      this.prisma.insurancePolicy.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.premiumPayment.findMany({ where: { workspaceId }, orderBy: { dueDate: 'asc' } }),
      this.prisma.importBatch.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.cardReminderCycle.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.telegramConnection.findMany({
        where: { workspaceId },
        // No botTokenRef and no bindingTokenHash: those are credentials.
        select: {
          id: true,
          userId: true,
          mode: true,
          chatId: true,
          botUsername: true,
          isEnabled: true,
          status: true,
          verifiedAt: true,
          createdAt: true,
          revokedAt: true,
        },
      }),
      this.prisma.ingestionMessage.findMany({
        where: { workspaceId },
        orderBy: { receivedAt: 'asc' },
      }),
      this.prisma.transactionDraft.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.auditEvent.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    if (!workspace) throw new NotFoundException('ওয়ার্কস্পেস পাওয়া যায়নি');

    this.audit.emit({
      workspaceId,
      actorUserId: ctx.id,
      action: 'export.downloaded',
      entity: 'Workspace',
      entityId: workspaceId,
      after: { format: 'json', transactionCount: transactions.length },
    });

    const body = {
      /* Versioned from the first release. An importer written against this
       * file in two years needs to know which shape it is looking at. */
      format: 'hishab.workspace-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      timezone: ctx.timezone,
      workspace,
      accounts,
      categories,
      people,
      transactions,
      loans,
      loanPayments,
      savingsPlans,
      savingsInstallments,
      insurancePolicies: policies,
      premiumPayments: premiums,
      importBatches,
      cardReminderCycles: cardCycles,
      telegramConnections: telegram,
      ingestionMessages,
      transactionDrafts,
      auditEvents,
    };

    return {
      filename: `hishab-export-${toLocalDateString(new Date(), ctx.timezone)}.json`,
      body: jsonSafe(body) as Record<string, unknown>,
    };
  }

  private async requireAccount(workspaceId: string, accountId: string): Promise<void> {
    const account = await this.prisma.account.count({
      where: { id: accountId, workspaceId, deletedAt: null },
    });
    // An account id from another workspace is a 404, never a hint that it exists.
    if (account !== 1) throw new NotFoundException('অ্যাকাউন্ট পাওয়া যায়নি');
  }
}

/**
 * Money out of Prisma is `bigint` and dates are `Date`; JSON has neither.
 *
 * Converted explicitly rather than leaning on the global `BigInt.toJSON` patch,
 * so this file produces the same bytes whatever else has been installed —
 * still an integer number of poisha, still no float. Anything past 2^53 poisha
 * is a bug and `minorToNumber` throws rather than losing precision quietly.
 */
function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return minorToNumber(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = jsonSafe(item);
    return out;
  }
  return value;
}
