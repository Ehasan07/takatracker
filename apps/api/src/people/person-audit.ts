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
 * TODO(main): `AUDIT_ACTIONS` in audit/audit.service.ts does not carry these
 * yet, and that file belongs to another change, so each string is asserted here
 * rather than edited in there. Nothing is wrong with the rows that get written —
 * `AuditEvent.action` is a plain `String` column, no enum and no migration.
 * Delete the assertions once these are in the union:
 *
 *   person.created
 *   person.updated
 *   person.deleted
 *   person.merged
 */
export const PERSON_CREATED = 'person.created' as AuditAction;
export const PERSON_UPDATED = 'person.updated' as AuditAction;
export const PERSON_DELETED = 'person.deleted' as AuditAction;
export const PERSON_MERGED = 'person.merged' as AuditAction;
