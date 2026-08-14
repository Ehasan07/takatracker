import type { Prisma } from '@prisma/client';

export interface PersonCode {
  code: string;
  codeSeq: number;
}

/**
 * The next free person code in a workspace: P-0001, P-0002.
 *
 * ## Why a code at all
 *
 * A number identifies most people and a name identifies none of them — but some
 * people have neither. Two suppliers called "রফিক এন্টারপ্রাইজ" reachable on the
 * same shop phone are two accounts, and somebody has to be able to point at one
 * of them on a delivery note. `id` is a cuid nobody will ever read down a phone;
 * this is short, ordered and printable.
 *
 * ## Why it lives here rather than on a service
 *
 * A person is created from three places — the People screen, recording a loan,
 * and adding a group member — and two of them are inside a transaction. One
 * path that forgot to allocate a code would be one path that made rows the
 * unique index then rejected, so the allocator takes whichever client the caller
 * is already holding.
 *
 * ## Why the highest and not a count
 *
 * A count hands out a code that already exists the moment anybody is deleted,
 * and a code that has appeared on a delivery note must never come to mean
 * somebody else. Codes are never reused. Two people created in the same instant
 * still collide on the unique index; that is the real guard, and the caller
 * retries.
 *
 * ## Why the highest is read from an integer
 *
 * `code` sorts as text, and text puts P-9999 above P-10000. Ordering by the
 * string handed out P-10000 twice once a workspace passed ten thousand people,
 * and the duplicate bounced off the unique index — a shop with a long supplier
 * list would simply have stopped being able to add one. `codeSeq` is the sort
 * key; the string is what gets printed.
 *
 * The padding is four digits because that is what makes a list read evenly, and
 * past 9999 it stops padding rather than truncating: P-10000 is longer and
 * still correct.
 */
export async function nextPersonCode(
  tx: Pick<Prisma.TransactionClient, 'person'>,
  workspaceId: string,
): Promise<PersonCode> {
  const latest = await tx.person.findFirst({
    where: { workspaceId },
    orderBy: { codeSeq: 'desc' },
    select: { codeSeq: true },
  });
  const codeSeq = (latest?.codeSeq ?? 0) + 1;
  return { code: `P-${String(codeSeq).padStart(4, '0')}`, codeSeq };
}
