import type { AuditAction } from '../audit/audit.service';

/**
 * The audit strings this module writes.
 *
 * A tag is not decoration. Merging পরিবার into পারিবারিক rewrites which rows a
 * report attributes to which label, and deleting one detaches it from every
 * transaction it was on — both are edits to how a household's history reads,
 * and neither leaves a trace anywhere else.
 *
 * TODO(main): `AUDIT_ACTIONS` in audit/audit.service.ts does not carry these
 * yet, and that file belongs to another change, so each string is asserted here
 * rather than edited in there. Nothing is wrong with the rows that get written —
 * `AuditEvent.action` is a plain `String` column, no enum and no migration.
 * Delete the assertions once these are in the union:
 *
 *   tag.created
 *   tag.updated
 *   tag.deleted
 *   tag.merged
 */
export const TAG_CREATED = 'tag.created' as AuditAction;
export const TAG_UPDATED = 'tag.updated' as AuditAction;
export const TAG_DELETED = 'tag.deleted' as AuditAction;
export const TAG_MERGED = 'tag.merged' as AuditAction;
