'use client';

import { Quote } from '@/components/icons';
import * as React from 'react';
import { cn } from '@/lib/utils';
import { locateEvidence } from './evidence';
import { fieldLabel, fieldTag, fieldTint } from './labels';

/**
 * The message, exactly as it arrived, with the parser's working shown over it.
 *
 * **This is rendered as text and only as text.** The body is somebody's own SMS
 * sitting in their own authenticated inbox, but it is still a string an
 * outsider chose: there is no `dangerouslySetInnerHTML` here and there must
 * never be one. Every run below is a React text child, so `<script>` and
 * `<img onerror=…>` reach the screen as the characters they are — which is
 * also the only correct thing to show, because the person is checking what
 * their bank actually sent.
 *
 * The highlights are the reason the API returns evidence at all. A figure the
 * parser *read* sits on the words it read; a figure it *inferred* has no
 * highlight anywhere, and the form beside this says so in as many words.
 */
export function RawMessage({
  body,
  evidence,
  className,
}: {
  body: string;
  evidence: Record<string, string>;
  className?: string;
}) {
  const { segments, unlocated } = React.useMemo(
    () => locateEvidence(body, evidence),
    [body, evidence],
  );

  const highlighted = segments.filter((segment) => segment.kind === 'evidence');

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <p
        className={cn(
          'border-rule bg-paper text-ink rounded-md border p-3 text-sm leading-7',
          // A 60-character URL in an SMS must wrap, not push the page sideways.
          'whitespace-pre-wrap break-words [overflow-wrap:anywhere]',
        )}
      >
        {segments.map((segment, index) =>
          segment.kind === 'text' ? (
            <React.Fragment key={index}>{segment.text}</React.Fragment>
          ) : (
            <mark
              key={index}
              /* `<mark>` arrives with a browser-yellow background and black
                 text; both are overridden so the tint survives dark mode. */
              className={cn(
                'text-ink rounded px-0.5 underline decoration-dotted decoration-2 underline-offset-4',
                fieldTint(segment.field),
              )}
              aria-label={`${fieldLabel(segment.field)} এখান থেকে পড়া হয়েছে: ${segment.text}`}
            >
              {segment.text}
              <span
                aria-hidden
                className="text-ink-muted ms-0.5 align-super text-[9px] font-medium"
              >
                {fieldTag(segment.field)}
              </span>
            </mark>
          ),
        )}
      </p>

      {highlighted.length > 0 ? (
        <ul className="flex flex-wrap gap-x-3 gap-y-1">
          {highlighted.map((segment, index) => (
            <li
              key={index}
              className="text-ink-muted flex min-w-0 items-center gap-1.5 text-[11px]"
            >
              <span
                aria-hidden
                className={cn('h-2.5 w-2.5 shrink-0 rounded-sm', fieldTint(segment.field))}
              />
              <span className="truncate">{fieldLabel(segment.field)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-ink-muted text-[11px]">
          এই বার্তা থেকে কোনো তথ্য পড়া যায়নি — নিচের ঘরগুলো নিজে পূরণ করতে হবে।
        </p>
      )}

      {/* A quotation we could not find in the body verbatim. Rare, and it means
          the parser and the stored text disagree — better said out loud than
          drawn over whatever happens to be nearby. */}
      {unlocated.length > 0 ? (
        <ul className="border-rule flex flex-col gap-1 rounded-md border border-dashed p-2">
          {unlocated.map((item) => (
            <li key={item.field} className="text-ink-muted flex min-w-0 items-start gap-1.5">
              <Quote className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              <span className="min-w-0 text-[11px]">
                {fieldLabel(item.field)} — <span className="font-mono">{item.text}</span> (বার্তার
                কোথায় লেখা আছে দেখানো গেল না)
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
