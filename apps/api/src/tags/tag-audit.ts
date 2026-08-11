import type { AuditAction } from '../audit/audit.service';

/**
 * The audit strings this module writes.
 *
 * A tag is not decoration. Merging পরিবার into পারিবারিক rewrites which rows a
 * report attributes to which label, and deleting one detaches it from every
 * transaction it was on — both are edits to how a household's history reads,
 * and neither leaves a trace anywhere else.
 *
 * Annotated, never `as AuditAction`. A cast compiles whatever string is on the
 * right of it, so a typo would ship a row under an action name no query looks
 * for; the annotation makes the union the authority and a rename upstream a
 * compile error here.
 */
export const TAG_CREATED: AuditAction = 'tag.created';
export const TAG_UPDATED: AuditAction = 'tag.updated';
export const TAG_DELETED: AuditAction = 'tag.deleted';
export const TAG_MERGED: AuditAction = 'tag.merged';
