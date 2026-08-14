import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  searchDocs,
  searchField,
  summariseLoan,
  type LoanPaymentInput,
  type LoanTerms,
  type SearchBucket,
  type SearchDoc,
} from '@hishab/core';
import { toBengaliDigits, toLocalDateString, personIdentityKeys } from '@hishab/shared';
import type { Person, Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { MAX_SEARCH_QUERY_LENGTH } from '../categories/categories.service';
import { minorToNumber } from '../common/bigint-json';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../transactions/transactions.service';
import { PERSON_CREATED, PERSON_DELETED, PERSON_MERGED, PERSON_UPDATED } from './person-audit';
import { normaliseBdPhone, phoneIdentity, storablePhone } from './phone';

/**
 * People — the counterparties a household lends to and borrows from.
 *
 * **Why this module exists.** Until now a `Person` could only come into being as
 * a side effect of recording a loan: `LoansService.resolvePerson` created one
 * from a typed name, and the only column it ever wrote back was a phone that had
 * been null. `relation`, `note` and `photoUri` were write-never, a phone typed
 * wrong was permanent, and the comment in that function pointed at "the contacts
 * screen" — which did not exist. The party ledger, the one place a
 * counterparty's whole history lives, could not rename the person it is about.
 *
 * **Why a person is not a tag.** A tag is an annotation: delete it and the
 * transaction survives intact, so `TagsService.remove` detaches and destroys
 * nothing. A person is the *subject* of a debt. A receivable pointing at nobody
 * is not a tidy row with a missing label, it is money owed by nobody — so the
 * delete here refuses while a loan still references them, and says how many.
 *
 * **Why merge matters more here than it did for tags.** Two tags spelled
 * differently split a report. Two people spelled differently split a *party
 * ledger*, and each half looks complete: it shows part of the debt, prints a net
 * position that is wrong, and gives no sign that the other half exists. Every
 * workspace created before the counterparty picker shipped has these — করিম
 * typed twice, one loan on each row — and merging is the only repair.
 */

// --- views -------------------------------------------------------------------

/**
 * One row of the contacts list.
 *
 * The numbers are not decoration, for the same reason a tag list carries its
 * counts: without them this is a list of names, and the user cannot tell the
 * cousin they have lent ৳40,000 to from a duplicate they created by mistake, nor
 * decide which of two করিমs is the one the history hangs off.
 *
 * Money is integer poisha throughout, exactly as the ledger stores it.
 */
export interface PersonView {
  id: string;
  name: string;
  /** Canonical `01XXXXXXXXX` when we recognised it — see `./phone`. */
  phone: string | null;
  relation: string | null;
  note: string | null;
  photoUri: string | null;
  /**
   * Loans that still mean something: live and not cancelled. The same
   * population `GET /loans/people/:id/ledger` puts on its running balance, so
   * this count never promises rows the ledger will not show.
   */
  loanCount: number;
  /** Still owed *to* the user, interest included. */
  receivableMinor: number;
  /** Still owed *by* the user, interest included. */
  payableMinor: number;
  /** `receivable − payable`. Positive means they owe us. The party position. */
  netMinor: number;
  /** Live transactions filed against this person, loan movements included. */
  transactionCount: number;
  /**
   * The last day anything happened with this person — a loan taken out, an
   * instalment, or any transaction filed against them — as a `YYYY-MM-DD` in
   * the workspace's own calendar. Null when nothing ever has.
   */
  lastActivityDate: string | null;
  createdAt: string;
  /**
   * Other live people in this workspace that look like the same human: the same
   * phone number after normalisation, or the same name ignoring case.
   *
   * Computed rather than stored, and offered rather than acted on. Merging is
   * irreversible from the UI, so the decision stays with the person who knows
   * whether the two করিমs are two cousins or one typo.
   */
  duplicateOfIds: string[];
  /**
   * Present only on a `?q=` response. `suggestion` means the query matched no
   * field and only the fuzzy rungs reached this row — a did-you-mean, not an
   * answer, and the client has to be able to say so.
   */
  bucket?: SearchBucket;
}

/** A create or update body, already narrowed by the controller's zod schema. */
export interface PersonWriteInput {
  readonly name?: string;
  readonly phone?: string | null;
  /** The second identity key; see `personIdentityKeys` in shared. */
  readonly email?: string | null;
  readonly relation?: string | null;
  readonly note?: string | null;
  readonly photoUri?: string | null;
}

/** Raw query-string values, untyped for the reason `ListCategoriesQuery` is. */
export interface ListPeopleQuery {
  readonly q?: unknown;
}

/** Which columns a merge filled in on the survivor from the row that went away. */
export type PersonField = 'phone' | 'relation' | 'note' | 'photoUri';

export interface DeletePersonResult {
  id: string;
  name: string;
  /** Transactions that keep pointing at the tombstone, so they keep their label. */
  transactionCount: number;
  message: string;
}

export interface MergePeopleResult {
  from: { id: string; name: string };
  into: { id: string; name: string };
  /** Every `Loan` row repointed, soft-deleted ones included. */
  movedLoanCount: number;
  /** Instalments that followed their loans. `LoanPayment` has no `personId`. */
  movedPaymentCount: number;
  /** Ledger transactions repointed — disbursements, repayments and manual rows. */
  movedTransactionCount: number;
  /** Blank columns on the survivor that the disappearing row filled in. */
  carriedOver: PersonField[];
  /**
   * Null when both rows had the same name, so nothing could be lost. Otherwise
   * the name that is going away and whether it survived as searchable text —
   * see `mergeNotes` for why that is a note and not an alias.
   */
  previousName: { value: string; kept: boolean } | null;
  message: string;
}

// --- limits -------------------------------------------------------------------

/**
 * The note column is free text in Postgres; this is the cap the controller
 * enforces on input, repeated here because `merge` writes a note nobody typed.
 */
const MAX_NOTE_LENGTH = 2000;

/**
 * A photo reference we are willing to put in an `<img src>`.
 *
 * `photoUri` has never been written by anything, so there is no stored format to
 * be compatible with and no upload flow yet. Rather than invent one, the column
 * accepts what a future one would produce — an absolute `https://` URL or a path
 * on our own origin — and refuses everything else. `javascript:` and `data:` are
 * the reason this check exists at all: the value is rendered by the client, and
 * a column no endpoint validates is a column the client has to distrust.
 */
const SAFE_PHOTO_URI = /^(?:https:\/\/[^\s]+|\/[^\s]*)$/;

@Injectable()
export class PeopleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // --- reads -------------------------------------------------------------------

  async list(ctx: TenantContext, query: ListPeopleQuery = {}): Promise<PersonView[]> {
    const q = parseSearchQuery(query.q);
    const views = await this.buildViews(ctx);
    return q === undefined ? views : searchPeople(views, q);
  }

  /**
   * One person, with the same numbers the list carries.
   *
   * Built from the whole workspace rather than from a single-row read, which
   * costs the same two queries as the list. That is deliberate: the editor and
   * the list must never disagree about what somebody is owed, and
   * `duplicateOfIds` cannot be computed from one row anyway.
   *
   * A person from another workspace is simply not in the set, so it 404s — the
   * `workspaceId` filter is the only thing standing between two tenants here and
   * it is applied before any id is compared.
   */
  async findOne(ctx: TenantContext, id: string): Promise<PersonView> {
    const view = (await this.buildViews(ctx)).find((row) => row.id === id);
    if (!view) throw new NotFoundException('ব্যক্তি পাওয়া যায়নি');
    return view;
  }

  // --- writes ------------------------------------------------------------------

  async create(ctx: TenantContext, input: PersonWriteInput): Promise<PersonView> {
    const name = requireName(input.name);
    const phone = storablePhone(input.phone);
    await this.assertPhoneFree(ctx.workspaceId, phone);

    const created = await this.prisma.person.create({
      data: {
        workspaceId: ctx.workspaceId,
        name,
        phone,
        /* The unique index is on these, not on `phone` — see
           `personIdentityKeys`. Written on every path that makes a person, or
           two rows for one human slip in through whichever path forgot. */
        ...personIdentityKeys({ phone, email: input.email }),
        relation: trimOrNull(input.relation),
        note: trimOrNull(input.note),
        photoUri: parsePhotoUri(input.photoUri),
      },
    });

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: PERSON_CREATED,
      entity: 'Person',
      entityId: created.id,
      after: { name: created.name, phone: created.phone },
    });

    return this.findOne(ctx, created.id);
  }

  /**
   * Edit a person.
   *
   * Every column is editable, including the name. What is *not* rewritten is the
   * description already stored on their old transactions —
   * `ধার দেওয়া — করিম (#L-0001)` keeps saying করিম after a rename to করিম
   * উদ্দিন. That text is what the books said at the time and the loans module
   * owns its format; a regex sweep over historical descriptions would be a
   * silent rewrite of the ledger to fix a cosmetic staleness. The party ledger,
   * the loan cards and the picker all render `person.name` live, so everything
   * that is about the person now says the new name immediately.
   */
  async update(ctx: TenantContext, id: string, input: PersonWriteInput): Promise<PersonView> {
    const existing = await this.requirePerson(ctx.workspaceId, id);

    const name = input.name === undefined ? existing.name : requireName(input.name);
    const phone = input.phone === undefined ? existing.phone : storablePhone(input.phone);
    if (phone !== existing.phone) {
      await this.assertPhoneFree(ctx.workspaceId, phone, id);
    }

    const updated = await this.prisma.person.update({
      where: { id },
      data: {
        name,
        phone,
        ...(input.relation === undefined ? {} : { relation: trimOrNull(input.relation) }),
        ...(input.note === undefined ? {} : { note: trimOrNull(input.note) }),
        ...(input.photoUri === undefined ? {} : { photoUri: parsePhotoUri(input.photoUri) }),
      },
    });

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: PERSON_UPDATED,
      entity: 'Person',
      entityId: id,
      before: { name: existing.name, phone: existing.phone, relation: existing.relation },
      after: { name: updated.name, phone: updated.phone, relation: updated.relation },
    });

    return this.findOne(ctx, id);
  }

  /**
   * Soft delete — and only while nothing owes anybody anything.
   *
   * A loan cannot exist without a counterparty: `Loan.personId` is not nullable,
   * and the party ledger is *about* the person. Removing one with debts open
   * would leave a receivable that belongs to nobody, which is worse than a
   * contact list with a name in it the user is finished with. So the refusal
   * names the count, because "this person has loans" gives somebody nothing to
   * act on and "৩টি ঋণ" tells them exactly what to go and clear.
   *
   * Transactions are the opposite case and are left alone. `Transaction.personId`
   * is nullable, the row survives without it, and the tombstone keeps the id
   * resolvable — so the khata goes on printing the name against the entries it
   * was already filed against instead of quietly losing it.
   */
  async remove(ctx: TenantContext, id: string): Promise<DeletePersonResult> {
    const existing = await this.requirePerson(ctx.workspaceId, id);

    /* Cancelled loans count. They are still rows on `GET /loans?personId=` and
     * on the party ledger's loan list, and every one of them would print the
     * name of somebody the contacts screen says is gone. Soft-deleted loans do
     * not: they are already out of every screen there is. */
    const loanCount = await this.prisma.loan.count({
      where: { workspaceId: ctx.workspaceId, personId: id, deletedAt: null },
    });
    if (loanCount > 0) {
      throw new BadRequestException(
        `"${existing.name}"-এর নামে ${toBengaliDigits(String(loanCount))}টি ঋণ আছে — তাই এখন মুছে ফেলা যাবে না। আগে ঋণগুলো মুছে ফেলুন, অথবা এই নামটি অন্য কারও সাথে মিলিয়ে নিন।`,
      );
    }

    const transactionCount = await this.prisma.transaction.count({
      where: { workspaceId: ctx.workspaceId, personId: id, deletedAt: null },
    });

    await this.prisma.person.update({ where: { id }, data: { deletedAt: new Date() } });

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: PERSON_DELETED,
      entity: 'Person',
      entityId: id,
      before: { name: existing.name, phone: existing.phone, transactionCount },
    });

    return {
      id,
      name: existing.name,
      transactionCount,
      message:
        transactionCount > 0
          ? `"${existing.name}" তালিকা থেকে সরানো হয়েছে। ${toBengaliDigits(String(transactionCount))}টি পুরনো লেনদেনে নামটি আগের মতোই থাকবে — কোনো লেনদেন মুছে ফেলা হয়নি।`
          : `"${existing.name}" তালিকা থেকে সরানো হয়েছে।`,
    };
  }

  /**
   * Fold one person into another.
   *
   * **What moves.** Every `Loan` row is repointed, soft-deleted ones included —
   * leaving one behind would keep a live foreign key on a retired person and
   * would resurrect the split the moment anybody restored it. `LoanPayment`
   * carries no `personId` at all: an instalment belongs to its loan, so the
   * payments follow without a single write, and the count is reported only so
   * the user can see the size of what just moved. Every `Transaction` filed
   * against the source is repointed too — the disbursements and repayments the
   * loans module wrote, and any manual row somebody tagged with the person by
   * hand.
   *
   * **What is kept.** The survivor's own values win; the disappearing row only
   * fills in blanks. A merge is not the place to overwrite a phone number
   * somebody checked with one they might not have — the same reasoning
   * `resolvePerson` applies when it declines to revise a stored number from a
   * loan form. Nothing is destroyed either way: the source row is soft-deleted,
   * so anything not carried over is still on the tombstone and in the audit row.
   *
   * **The old name.** Tags solve this with `searchAliases`, so `poribar` keeps
   * finding পরিবার after the merge. `Person` has no such column (see
   * `mergeNotes`), and this change does not own the schema — so the old spelling
   * is kept in the note, which the matcher does index, and the response says
   * plainly whether it landed.
   */
  async merge(
    ctx: TenantContext,
    sourceId: string,
    intoPersonId: string,
  ): Promise<MergePeopleResult> {
    if (sourceId === intoPersonId) {
      throw new BadRequestException('একজন ব্যক্তিকে নিজের সাথেই মেলানো যায় না');
    }

    const [source, target] = await Promise.all([
      this.prisma.person.findFirst({
        where: { id: sourceId, workspaceId: ctx.workspaceId, deletedAt: null },
      }),
      this.prisma.person.findFirst({
        where: { id: intoPersonId, workspaceId: ctx.workspaceId, deletedAt: null },
      }),
    ]);
    /* One message for both, and a 404 rather than a 403. A workspace must not be
     * able to learn that a person id exists somewhere else from the shape of the
     * refusal it gets back. */
    if (!source || !target) throw new NotFoundException('ব্যক্তি পাওয়া যায়নি');

    const previousNameLine = previousNameNote(target, source);
    const profile = mergeProfile(target, source, previousNameLine);

    const moved = await this.prisma.$transaction(async (tx) => {
      /* Counted before the loans move, while they can still be found by the
       * source's id. Nothing is written for them — they travel with their loan. */
      const movedPaymentCount = await tx.loanPayment.count({
        where: { workspaceId: ctx.workspaceId, loan: { personId: sourceId } },
      });

      /* `workspaceId` on every one of these, redundantly — the two people were
       * already proven to be this workspace's. It stays because these are the
       * only writes in the module that could reach another tenant's rows if an
       * id above were ever trusted from somewhere else. */
      const { count: movedLoanCount } = await tx.loan.updateMany({
        where: { workspaceId: ctx.workspaceId, personId: sourceId },
        data: { personId: intoPersonId },
      });
      const { count: movedTransactionCount } = await tx.transaction.updateMany({
        where: { workspaceId: ctx.workspaceId, personId: sourceId },
        data: { personId: intoPersonId },
      });

      await tx.person.update({ where: { id: intoPersonId }, data: profile.data });
      await tx.person.update({ where: { id: sourceId }, data: { deletedAt: new Date() } });

      return { movedLoanCount, movedPaymentCount, movedTransactionCount };
    });

    const previousName = previousNameLine
      ? { value: source.name, kept: profile.previousNameKept }
      : null;

    this.audit.emit({
      workspaceId: ctx.workspaceId,
      actorUserId: ctx.id,
      action: PERSON_MERGED,
      entity: 'Person',
      /* Filed against the survivor, not the row that disappeared. "What happened
       * to the other করিম?" is the question this line has to answer, and an
       * entityId pointing at a person who no longer appears anywhere answers
       * nothing. The source's own values ride along in `before`, which is the
       * only place a merged-away phone or note is readable afterwards. */
      entityId: intoPersonId,
      before: {
        id: sourceId,
        name: source.name,
        phone: source.phone,
        relation: source.relation,
        note: source.note,
      },
      after: {
        name: target.name,
        ...moved,
        carriedOver: profile.carriedOver,
      },
    });

    return {
      from: { id: sourceId, name: source.name },
      into: { id: intoPersonId, name: target.name },
      ...moved,
      carriedOver: profile.carriedOver,
      previousName,
      message: `"${source.name}" কে "${target.name}"-এর সাথে মিলিয়ে দেওয়া হয়েছে — ${toBengaliDigits(String(moved.movedLoanCount))}টি ঋণ ও ${toBengaliDigits(String(moved.movedTransactionCount))}টি লেনদেন সরানো হয়েছে। কিছুই মুছে ফেলা হয়নি।`,
    };
  }

  // --- internals ---------------------------------------------------------------

  /**
   * The whole contacts list, with everything hanging off each person.
   *
   * Three workspace-scoped queries and no fourth. Everything below — the
   * outstanding maths, the last-activity date, the duplicate grouping, and the
   * `?q=` match on top of it — runs in memory over exactly these rows, so no
   * later step can widen the set past this `workspaceId`.
   *
   * The loans come back whole, with their payments, because outstanding *with
   * interest* cannot be summed in SQL: a PERCENT loan's interest depends on the
   * day it was settled, which `@hishab/core` works out by walking the
   * repayments. `GET /loans/dashboard` already loads the same population for the
   * same reason, and a household's loans are a list somebody scrolls rather than
   * a table somebody mines.
   */
  private async buildViews(ctx: TenantContext): Promise<PersonView[]> {
    const [people, loans, transactions] = await Promise.all([
      this.prisma.person.findMany({
        where: { workspaceId: ctx.workspaceId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.loan.findMany({
        where: { workspaceId: ctx.workspaceId, deletedAt: null },
        select: loanFacts,
      }),
      this.prisma.transaction.groupBy({
        by: ['personId'],
        where: { workspaceId: ctx.workspaceId, deletedAt: null, personId: { not: null } },
        _count: { _all: true },
        _max: { date: true },
      }),
    ]);

    const tz = ctx.timezone;
    const today = calendarDay(toLocalDateString(new Date(), tz));
    const stats = new Map<string, PersonStats>();
    const statsFor = (personId: string): PersonStats => {
      const existing = stats.get(personId);
      if (existing) return existing;
      const blank: PersonStats = {
        loanCount: 0,
        receivableMinor: 0,
        payableMinor: 0,
        transactionCount: 0,
        lastActivityDate: null,
      };
      stats.set(personId, blank);
      return blank;
    };

    for (const loan of loans) {
      const row = statsFor(loan.personId);

      /* Anything that happened is activity, cancelled loans included: the
       * question this date answers is "when did I last deal with this person",
       * not "when did they last owe me". */
      row.lastActivityDate = laterIso(row.lastActivityDate, toLocalDateString(loan.loanDate, tz));
      for (const payment of loan.payments) {
        row.lastActivityDate = laterIso(row.lastActivityDate, toLocalDateString(payment.date, tz));
      }

      // Cancelled loans were reversed out of the ledger; they owe nothing.
      if (loan.status === 'CANCELLED') continue;

      const progress = summariseLoan(termsOf(loan, tz), paymentInputsOf(loan, tz), today);
      row.loanCount += 1;
      if (loan.direction === 'LENT') row.receivableMinor += progress.outstandingMinor;
      else row.payableMinor += progress.outstandingMinor;
    }

    for (const group of transactions) {
      if (group.personId === null) continue;
      const row = statsFor(group.personId);
      row.transactionCount = group._count._all;
      if (group._max.date) {
        row.lastActivityDate = laterIso(
          row.lastActivityDate,
          toLocalDateString(group._max.date, tz),
        );
      }
    }

    const duplicates = findDuplicates(people);

    const views = people.map((person) => {
      const row = statsFor(person.id);
      return {
        id: person.id,
        name: person.name,
        phone: person.phone,
        relation: person.relation,
        note: person.note,
        photoUri: person.photoUri,
        loanCount: row.loanCount,
        receivableMinor: row.receivableMinor,
        payableMinor: row.payableMinor,
        netMinor: row.receivableMinor - row.payableMinor,
        transactionCount: row.transactionCount,
        lastActivityDate: row.lastActivityDate,
        createdAt: person.createdAt.toISOString(),
        duplicateOfIds: duplicates.get(person.id) ?? [],
      } satisfies PersonView;
    });

    /* Alphabetical, because this is a contact list and scrolling to a name is
     * how somebody finds one without typing. `localeCompare` with `bn` so
     * Bengali sorts by its own alphabet rather than by code point; the person's
     * age in the workspace is the tie-break, which keeps two identical names in
     * the order `resolvePerson` considers them. */
    return views.sort(
      (a, b) => a.name.localeCompare(b.name, 'bn') || a.createdAt.localeCompare(b.createdAt),
    );
  }

  private async requirePerson(workspaceId: string, id: string): Promise<Person> {
    const person = await this.prisma.person.findFirst({
      where: { id, workspaceId, deletedAt: null },
    });
    if (!person) throw new NotFoundException('ব্যক্তি পাওয়া যায়নি');
    return person;
  }

  /**
   * Two people may share a name — two cousins really are both করিম, and refusing
   * that would make this screen unusable — but not a phone number. A number
   * belongs to one person, so a clash is an identification, and the refusal
   * names who already holds it and offers the merge instead.
   *
   * Compared in memory rather than with a `where: { phone }`, because rows
   * written before `./phone` existed still hold `+880…` and would slip past a
   * SQL equality against the canonical `01…`. Workspace-sized, one query.
   */
  private async assertPhoneFree(
    workspaceId: string,
    phone: string | null,
    exceptId?: string,
  ): Promise<void> {
    const identity = phoneIdentity(phone);
    if (identity === null) return;

    const rows = await this.prisma.person.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        phone: { not: null },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true, name: true, phone: true },
    });

    const clash = rows.find((row) => phoneIdentity(row.phone) === identity);
    if (clash) {
      throw new BadRequestException(
        `এই নম্বরটি "${clash.name}"-এর নামে আগে থেকেই আছে — একই ব্যক্তি হলে দুজনকে মিলিয়ে নিন`,
      );
    }
  }
}

// --- loan maths ----------------------------------------------------------------

/**
 * Everything a loan contributes to a person's position, and nothing else.
 *
 * Deliberately narrower than `loans.service.ts`'s `loanInclude`: this endpoint
 * needs no account names, no attachments and no person join, and loading them
 * for every loan in the workspace would be paid on every keystroke of the search
 * box.
 */
const loanFacts = {
  personId: true,
  direction: true,
  status: true,
  principalMinor: true,
  interestType: true,
  interestMinor: true,
  interestRateBps: true,
  loanDate: true,
  dueDate: true,
  payments: { select: { amountMinor: true, date: true } },
} satisfies Prisma.LoanSelect;

type LoanFacts = Prisma.LoanGetPayload<{ select: typeof loanFacts }>;

interface PersonStats {
  loanCount: number;
  receivableMinor: number;
  payableMinor: number;
  transactionCount: number;
  lastActivityDate: string | null;
}

/**
 * A Date whose *local* components are that calendar day at midnight.
 *
 * The same conversion `loans.service.ts` does, and it has to be: `@hishab/core`
 * reads loan dates by their local calendar day, so handing it the raw UTC
 * instant out of Postgres would read the day in whatever timezone the server
 * happens to run in. Copied rather than imported because it is private to that
 * module; the arithmetic that matters — interest, settlement, outstanding — is
 * not copied at all, it is `summariseLoan` in @hishab/core, which is the single
 * source of truth this list shares with the party ledger and the dashboard.
 */
function calendarDay(isoDate: string): Date {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const day = Number(isoDate.slice(8, 10));
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

function termsOf(loan: LoanFacts, timezone: string): LoanTerms {
  return {
    principalMinor: minorToNumber(loan.principalMinor),
    interestType: loan.interestType,
    interestMinor: minorToNumber(loan.interestMinor),
    interestRateBps: loan.interestRateBps,
    loanDate: calendarDay(toLocalDateString(loan.loanDate, timezone)),
    dueDate: loan.dueDate ? calendarDay(toLocalDateString(loan.dueDate, timezone)) : null,
  };
}

/**
 * The repayments as core wants them — always dated, so `summariseLoan` stops the
 * interest clock on the day the debt was cleared rather than letting it run to
 * today. Drop the date and a settled PERCENT loan quietly reopens tomorrow.
 */
function paymentInputsOf(loan: LoanFacts, timezone: string): LoanPaymentInput[] {
  return loan.payments.map((payment) => ({
    amountMinor: minorToNumber(payment.amountMinor),
    date: calendarDay(toLocalDateString(payment.date, timezone)),
  }));
}

/** `YYYY-MM-DD` sorts lexicographically, which is the whole reason it is used. */
function laterIso(current: string | null, candidate: string): string {
  return current === null || candidate > current ? candidate : current;
}

// --- duplicates -----------------------------------------------------------------

/**
 * Which people look like the same human.
 *
 * Two signals, both conservative. A shared phone number after normalisation is
 * near-certain: a number belongs to one person. A shared name ignoring case is
 * only a suspicion — two cousins really are both করিম — which is why this is a
 * hint on a row and never an automatic merge.
 *
 * Names are compared with `toLowerCase`, never `toLocaleLowerCase`: under a
 * Turkish locale the latter folds `I` to `ı` and two devices would disagree
 * about what is a duplicate. On Bengali it is a no-op, which is correct — the
 * script has no case — and it still catches `Karim` against `karim`.
 */
function findDuplicates(people: readonly Person[]): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  const add = (key: string | null, id: string): void => {
    if (key === null) return;
    const group = byKey.get(key);
    if (group) group.push(id);
    else byKey.set(key, [id]);
  };

  for (const person of people) {
    add(phoneIdentity(person.phone), person.id);
    const name = person.name.trim().toLowerCase();
    if (name !== '') add(`name:${name}`, person.id);
  }

  const out = new Map<string, string[]>();
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    for (const id of group) {
      const seen = out.get(id) ?? [];
      for (const other of group) {
        if (other !== id && !seen.includes(other)) seen.push(other);
      }
      out.set(id, seen);
    }
  }
  return out;
}

// --- merge ----------------------------------------------------------------------

interface MergedProfile {
  data: Pick<Person, 'phone' | 'relation' | 'note' | 'photoUri'>;
  carriedOver: PersonField[];
  previousNameKept: boolean;
}

/**
 * The line that keeps the disappearing spelling findable, or null when the two
 * rows already share a name and nothing can be lost.
 */
function previousNameNote(target: Person, source: Person): string | null {
  const same = target.name.trim().toLowerCase() === source.name.trim().toLowerCase();
  return same ? null : `আগের নাম: ${source.name.trim()}`;
}

/** The survivor's columns after the merge: its own values, then the blanks filled. */
function mergeProfile(
  target: Person,
  source: Person,
  previousNameLine: string | null,
): MergedProfile {
  const carriedOver: PersonField[] = [];

  const fill = (field: PersonField, mine: string | null, theirs: string | null): string | null => {
    const kept = trimOrNull(mine);
    if (kept !== null) return kept;
    const incoming = trimOrNull(theirs);
    if (incoming === null) return null;
    carriedOver.push(field);
    return incoming;
  };

  const phone = fill('phone', target.phone, source.phone);
  const relation = fill('relation', target.relation, source.relation);
  const photoUri = fill('photoUri', target.photoUri, source.photoUri);
  const note = mergeNotes(target.note, source.note, previousNameLine);
  if (note.text !== trimOrNull(target.note)) carriedOver.push('note');

  return {
    data: { phone, relation, note: note.text, photoUri },
    carriedOver,
    previousNameKept: note.previousNameKept,
  };
}

/**
 * The survivor's note after a merge, and where the old name goes.
 *
 * **Why the note and not an alias.** Tags carry `searchAliases`, so folding
 * পরিবার into পারিবারিক keeps `poribar` working for somebody who has typed it
 * for a year. `Person` has no such column — the model is `name`, `phone`,
 * `relation`, `note`, `photoUri` and nothing else — and adding one is a schema
 * change this module does not own. The note is the next best thing and not a bad
 * one: the matcher already indexes it (at `FREE` weight, below the name and the
 * phone, which is exactly right for a name that is no longer current), so
 * `korim` still reaches the survivor afterwards.
 *
 * It is a visible edit to a field the user owns, which is why it is written in
 * Bengali in the form of a sentence, reported in the response, and mirrored in
 * the audit row. A silent one would be worse.
 *
 * Both notes are kept when both exist — the merge is not the place to decide
 * which of two things somebody wrote down matters less. When the result would
 * pass the column's cap, the survivor's own note is left exactly as it was and
 * nothing is appended: the source's note is still on its soft-deleted row and in
 * the audit entry, so it is recoverable, and a truncated note is not.
 */
function mergeNotes(
  targetNote: string | null,
  sourceNote: string | null,
  previousNameLine: string | null,
): { text: string | null; previousNameKept: boolean } {
  const lines: string[] = [];
  const push = (value: string | null): void => {
    const line = value?.trim() ?? '';
    if (line === '' || lines.includes(line)) return;
    lines.push(line);
  };

  const mine = trimOrNull(targetNote);
  push(mine);
  push(sourceNote);

  let base = lines.join('\n');
  if (base.length > MAX_NOTE_LENGTH) base = mine ?? '';

  if (previousNameLine === null) {
    return { text: base === '' ? null : base, previousNameKept: false };
  }
  // A second merge of the same name has nothing to add and has lost nothing.
  if (base.includes(previousNameLine)) {
    return { text: base === '' ? null : base, previousNameKept: true };
  }

  const withName = base === '' ? previousNameLine : `${base}\n${previousNameLine}`;
  if (withName.length > MAX_NOTE_LENGTH) {
    return { text: base === '' ? null : base, previousNameKept: false };
  }
  return { text: withName, previousNameKept: true };
}

// --- input ----------------------------------------------------------------------

function trimOrNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function requireName(value: string | undefined): string {
  const name = value?.trim() ?? '';
  if (name === '') throw new BadRequestException('ব্যক্তির নাম দিন');
  return name;
}

function parsePhotoUri(value: string | null | undefined): string | null {
  const uri = trimOrNull(value);
  if (uri === null) return null;
  if (!SAFE_PHOTO_URI.test(uri)) {
    throw new BadRequestException('ছবির ঠিকানা https:// দিয়ে শুরু হতে হবে');
  }
  return uri;
}

// --- search ----------------------------------------------------------------------

/**
 * Match and rank the workspace's people against `q`, in memory.
 *
 * The same shape as `searchCategories` and `searchTags`, in memory for the same
 * reason: a workspace holds a few dozen contacts, they are already loaded to
 * attach the balances, and ranking them is not measurable next to the round trip
 * that fetched them.
 *
 * Pushing `q` into SQL as `WHERE name ILIKE '%…%'` would destroy the feature.
 * Postgres cannot transliterate: `lower()` is a no-op on a script with no case,
 * `unaccent` has no Bengali rules, and the trigram similarity between করিম and
 * `karim` is zero because they share no trigrams. `?q=karim` finds করিম — and so
 * does `?q=korim` — only because the fold runs here.
 *
 * **There is no alias field, and it is not an oversight.** `Person` has no
 * `searchAliases` column (`prisma/schema.prisma`: `name`, `phone`, `relation`,
 * `note`, `photoUri`), so there is nothing to pass to `searchAliasField` and
 * this module does not own the schema. The note carries that weight instead —
 * see `mergeNotes` — which is why it is indexed rather than left out.
 *
 * Suggestions stay on. A picker that cannot find করিম when the user types
 * `karim` is exactly how a workspace ends up with two করিমs, and a near-miss
 * offered *as* a near-miss is far better than an empty list that invites
 * somebody to type the name a second time.
 */
function searchPeople(views: readonly PersonView[], rawQuery: string): PersonView[] {
  /* A phone typed in any of the spellings `./phone` recognises is folded to the
   * canonical form before it is matched, so `+8801711223344` finds the row
   * stored as `01711223344`. Whole-query only: half a number inside a longer
   * query is still just text, and the matcher handles that better than a
   * substitution would. */
  const query = normaliseBdPhone(rawQuery) ?? rawQuery;

  const docs: SearchDoc<PersonView>[] = views.map((person, index) => ({
    id: person.id,
    row: person,
    order: index,
    fields: [
      searchField('name', 'PRIMARY', person.name),
      searchField('phone', 'SECONDARY', person.phone),
      /* The canonical form of a *stored* number, for rows written before
       * normalisation existed: a person saved as `+8801711223344` last year is
       * still found by the `01711223344` somebody types today. Omitted when the
       * stored value is already canonical, so the common row indexes one key. */
      searchField('phone', 'SECONDARY', canonicalIfDifferent(person.phone)),
      /* Relation and note are how somebody finds the cousin whose name they
       * cannot spell — and where a merged-away name lives. Below the name,
       * never instead of it. */
      searchField('relation', 'SECONDARY', person.relation),
      searchField('note', 'FREE', person.note),
    ],
  }));

  const result = searchDocs(docs, query);

  /* A one-character query is not a filter: it matches nearly every row at the
   * weakest tier, which is indistinguishable from no filter and far more
   * surprising. Hand back the natural list rather than a ranked pretence. */
  if (!result.filtered) return [...views];

  /* Suggestions appended rather than interleaved — the matcher keeps the bands
   * apart, and only fills the bucket when the real matches nearly ran out. The
   * bucket rides onto the row so the client cannot lose the distinction. */
  return [...result.hits, ...result.suggestions].map((hit) => ({ ...hit.row, bucket: hit.bucket }));
}

function canonicalIfDifferent(phone: string | null): string | null {
  const canonical = normaliseBdPhone(phone);
  return canonical !== null && canonical !== phone ? canonical : null;
}

// --- query parameters -------------------------------------------------------------

function parseSearchQuery(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  /* A repeated `?q=` arrives as an array. Silently taking the first would search
   * for something the user did not ask for, which is worse than refusing. */
  if (typeof value !== 'string') throw new BadRequestException('খোঁজার শব্দ একবারই দিন');
  if (value.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new BadRequestException(
      `খোঁজার শব্দ ${toBengaliDigits(String(MAX_SEARCH_QUERY_LENGTH))} অক্ষরের বেশি হতে পারবে না`,
    );
  }
  return value;
}
