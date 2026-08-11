import type { AuditAction } from '../audit/audit.service';

/**
 * The audit strings this module writes.
 *
 * A person is not a label. Renaming one changes whose name the party ledger,
 * every loan card and the counterparty picker are about; correcting a phone
 * changes which row a future loan resolves to; merging two folds one person's
 * whole history into another's and retires a row the books used to point at.
 * All four are edits to *whose* money this is, and nothing else in the system
 * records them — the `Person` row itself keeps only its current values.
 *
 * Annotated, never `as AuditAction` — see `tags/tag-audit.ts` for why a cast
 * here would let a typo through to a row nothing ever reads back.
 */
export const PERSON_CREATED: AuditAction = 'person.created';
export const PERSON_UPDATED: AuditAction = 'person.updated';
export const PERSON_DELETED: AuditAction = 'person.deleted';
export const PERSON_MERGED: AuditAction = 'person.merged';
