# Sharing a statement

A link somebody outside the app can open, showing one subject's ledger over one
date range, and nothing else.

The case is ordinary and the product could not do it: you have lent money to a
relative, or you pay a premium to an insurer, and they ask for the account.
Today the only answer is a screenshot, or reading numbers down the phone.

## What a link is, exactly

One row in `StatementShare`, and everything the public page is allowed to show
comes from it:

|               |                                              |
| ------------- | -------------------------------------------- |
| `kind`        | `PERSON`, `LOAN`, `SAVINGS` or `INSURANCE`   |
| `subjectId`   | which person, loan, plan or policy           |
| `from` / `to` | the window, or null for the whole life of it |
| `expiresAt`   | when it stops working                        |
| `revokedAt`   | set the moment the owner takes it back       |

The link cannot be widened by the person holding it. Changing the dates in the
URL does nothing, because the dates are not in the URL — they are in the row.
That is the whole reason the window is stored rather than passed.

## The token

Thirty-two random bytes, base64url. Only its SHA-256 hash is stored, exactly as
refresh tokens are: a leaked database backup must not hand somebody a working
statement link.

The plaintext exists once, in the response that creates it. If the owner loses
it they revoke and make another; there is no way to read an existing one back,
and that is deliberate.

## What it deliberately does not do

- **No login, and no attempt to identify the reader.** A creditor should not
  need an account in a product they are not a customer of. That means the link
  itself is the credential, which is why it expires by default and can be
  revoked in one tap.
- **No workspace-wide anything.** The query is scoped to the subject and the
  window before it touches the database. There is no code path from a share
  token to another person's row.
- **Not indexed.** `noindex` on the page and `X-Robots-Tag` on the response, so
  a link pasted into a public thread does not end up in a search result.
- **No editing.** Read and print. A statement somebody can change is not a
  statement.

## What the owner can see

Every share is listed on the subject's own screen: when it was made, when it
expires, how many times it has been opened and when it was last opened. A link
that has been read forty times by somebody who was sent it once is a fact the
owner should be able to notice.

Creating and revoking are both audit events, so `/audit` answers "who sent this
person our figures, and when".

## Printing

The public page prints to PDF from the browser, which is what every phone and
every desktop already has. No PDF library, no server-side rendering, nothing to
keep patched — the print stylesheet is a dozen lines and the output is a real,
selectable, searchable document rather than a picture of one.
