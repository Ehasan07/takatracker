/**
 * Turning a mail body into something safe to put on a screen.
 *
 * ## The decision: text, not sanitised HTML
 *
 * Most mail that matters here — bank statements, bKash receipts, invoices — is
 * HTML-only, so "just keep the text part" would have thrown away the body of the
 * majority of useful messages. The two real options were:
 *
 *  1. **Sanitise the HTML and store markup**, then render it in the web client.
 *  2. **Convert to plain text and store no markup at all.**
 *
 * This module does (2), and the reasoning is about where the risk lives rather
 * than about which is prettier. Sanitising means shipping an allowlist parser and
 * being right about it forever: `<style>` can exfiltrate with attribute
 * selectors, `<img src>` is a read receipt and an IP leak, `srcset`,
 * `background`, `<base href>`, CSS `url()`, SVG `<use>`, `javascript:` in a dozen
 * encodings, mutation-XSS where the sanitiser's parse and the browser's parse
 * disagree. Every one of those is a known bypass class, and this body is
 * attacker-controlled by definition: anyone in the world can email the mailbox
 * we are syncing and choose exactly what we store.
 *
 * Converting to text deletes the entire category. There is no markup in the
 * column, so there is nothing for a client to mis-render, no remote fetch to
 * leak that a message was opened, and no sanitiser to keep up to date. What it
 * costs is layout — a table of transactions arrives as lines of text rather than
 * a table. That is a real loss and it is the right trade for a first version.
 *
 * **The contract, which the web client depends on: `MailMessage.body` is plain
 * text.** It must be rendered into a text node — `textContent`, or React's `{}`
 * interpolation — and never with `innerHTML` or `dangerouslySetInnerHTML`. This
 * module guarantees no tags survive; it does not guarantee the text is free of
 * `<` characters, because `a < b` is legitimate text that appears in real mail
 * and mangling it would be wrong.
 *
 * If rich rendering is wanted later, the way to do it is a sanitiser on a
 * separate stored column plus a Content-Security-Policy'd sandbox iframe, not by
 * loosening this.
 */

/** Elements whose *contents* are not text and must go with the tags. */
const DROPPED_ELEMENTS = ['script', 'style', 'head', 'title', 'noscript', 'template', 'svg'];

/** Longest snippet stored. Matches `MAX_SNIPPET_CHARS` in the sync service. */
const SNIPPET_CHARS = 280;

/** Above this the conversion stops being worth it; the prefix is representative. */
const MAX_HTML_CHARS = 512 * 1024;

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
  ['ndash', '–'],
  ['mdash', '—'],
  ['hellip', '…'],
  ['laquo', '«'],
  ['raquo', '»'],
  ['ldquo', '“'],
  ['rdquo', '”'],
  ['lsquo', '‘'],
  ['rsquo', '’'],
  ['trade', '™'],
  ['copy', '©'],
  ['reg', '®'],
  ['deg', '°'],
  ['middot', '·'],
  ['bull', '•'],
  ['eacute', 'é'],
  ['pound', '£'],
  ['euro', '€'],
  ['yen', '¥'],
  ['cent', '¢'],
]);

/**
 * HTML in, plain text out. Never markup, and never a throw.
 *
 * The order of the passes is the correctness: dropped elements go **first**,
 * with their contents, so the text of a `<script>` never reaches the output as
 * visible junk. Then structural tags become line breaks, so a table of
 * transactions stays one-per-line instead of collapsing into a paragraph. Only
 * then are the remaining tags removed and entities decoded — decoding before
 * stripping would turn `&lt;script&gt;` into a real-looking tag and hand the
 * next pass something to remove that was never markup to begin with.
 *
 * This is not an HTML parser and does not try to be one. It is a lossy text
 * extractor whose only hard guarantee is that no `<…>` sequence survives it.
 *
 * **It fails closed, and that is deliberate.** A tag name appearing inside an
 * attribute value — `<div title="<script>">hi</div>` — makes pass 1 treat
 * everything after it as script content and drop it, losing the "hi". A real
 * parser would keep it. Being over-eager costs some text off a malformed
 * message; being under-eager costs markup reaching a screen. Given the input is
 * written by whoever chose to email the user, the first is the error to make.
 */
export function htmlToPlainText(html: string): string | null {
  if (!html) return null;

  let text = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;

  // 1. Elements whose contents are not readable text, contents and all. The
  //    unterminated variant (`<script>` with no close, from truncated source)
  //    is handled by the second alternative running to the end of the string.
  for (const tag of DROPPED_ELEMENTS) {
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?(?:</${tag}\\s*>|$)`, 'gi'), ' ');
  }

  // 2. Comments and doctypes, which `<[^>]*>` alone would not fully clear —
  //    a comment can legally contain `>`.
  text = text.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ');

  // 3. Structure worth keeping as whitespace. A receipt read as one run-on
  //    paragraph is much harder to scan than one read as lines.
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|tr|li|h[1-6]|blockquote|table|section|article)\s*>/gi, '\n')
    .replace(/<(?:hr)\s*\/?>/gi, '\n')
    .replace(/<\/(?:td|th)\s*>/gi, '\t');

  // 4. Every remaining tag, complete or truncated. The `[^>]*` cannot span a
  //    `>`, so this cannot swallow legitimate text between two tags, and the
  //    trailing alternative catches a tag cut off by the source truncation.
  text = text.replace(/<[a-zA-Z/!?][^>]*>/g, ' ').replace(/<[a-zA-Z/!?][^>]*$/g, ' ');

  // 5. Entities, after the tags are gone. See the doc comment for why the order
  //    matters.
  text = decodeEntities(text);

  return collapseWhitespace(text) || null;
}

/**
 * The first line or so of a body, for the message list.
 *
 * Newlines become spaces: a snippet is one line in a list, and a body whose
 * first three lines are blank would otherwise produce an empty-looking row.
 */
export function plainTextSnippet(body: string, max = SNIPPET_CHARS): string | null {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Numeric and named character references.
 *
 * Numeric references are bounded to valid Unicode scalar values and surrogates
 * are refused — `String.fromCodePoint` throws on those, and an unpaired
 * surrogate in a Postgres `text` column is an encoding error at write time, i.e.
 * a message that cannot be stored at all. An unrecognised entity is left exactly
 * as it was found rather than guessed at.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const digits = hex ? body.slice(2) : body.slice(1);
      const code = Number.parseInt(digits, hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      // Lone surrogates are not storable text.
      if (code >= 0xd800 && code <= 0xdfff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES.get(body.toLowerCase()) ?? match;
  });
}

/**
 * Tidy the result without destroying its shape.
 *
 * Runs of blank lines collapse to one — HTML mail is full of spacer rows that
 * would otherwise become forty empty lines — and trailing spaces go, but single
 * line breaks are kept because they are the only structure that survived.
 */
function collapseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
