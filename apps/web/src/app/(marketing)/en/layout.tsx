import { HtmlLang } from './html-lang';

/**
 * The English pages carry `lang="en"`.
 *
 * `<html>` belongs to the root layout, which is shared by every route and
 * cannot know which one is rendering without reading a request header — and
 * doing that would make every page dynamic, which would cost the whole public
 * site its static generation and its 172-byte payload. That is a bad trade for
 * one attribute.
 *
 * So the attribute is set on the client, and the *authoritative* signal to a
 * search engine stays where it belongs: the `hreflang` links in the head, which
 * are server-rendered and which Google weighs above `lang` for exactly this
 * case. A screen reader gets the right pronunciation as soon as the page is
 * interactive, which is before anybody has read a sentence of it.
 */
export default function EnglishLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <HtmlLang lang="en" />
      {children}
    </>
  );
}
