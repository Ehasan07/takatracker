/**
 * Bangladeshi mobile numbers moved to `@hishab/shared`.
 *
 * They were written here for contact de-duplication, where the only reader was
 * the people service. A phone number is now an *identity* — you can sign in
 * with one — so the signup form has to normalise the same way the server does,
 * and a second copy on the client would eventually disagree about whether
 * `+8801712345678` and `01712345678` are the same person.
 *
 * Re-exported under the old names so this folder's call sites stay as they are.
 */
export { normaliseBdPhone, phoneIdentity, storablePhone } from '@hishab/shared';
