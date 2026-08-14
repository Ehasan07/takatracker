/**
 * Digital Asset Links — the file that makes a TWA an app rather than a browser.
 *
 * ## What it is for
 *
 * A Trusted Web Activity shows this site full-screen with no address bar, but
 * only if the site vouches for the Android package that is asking. That vouching
 * is this file: Chrome fetches it, checks that the package name and the signing
 * certificate's SHA-256 fingerprint appear here, and drops the bar. Without it
 * the app opens with a URL bar across the top — a browser wearing an icon, and
 * it reads as one.
 *
 * ## Why it is a route and not a static file
 *
 * The fingerprint is not knowable until Play has signed the release, and Play
 * re-signs with a key of its own — so the value comes out of the console after
 * the first upload, and changes again if the app is ever re-keyed. An
 * environment variable is a deploy away; a committed file is a release away, and
 * would sit in git looking like a secret while not being one.
 *
 * Returns an empty array until the variable is set, which is the honest answer:
 * no package is vouched for yet. Chrome reads that as "no association" and keeps
 * the address bar, rather than half-associating with a fingerprint that is wrong.
 */

/** From the Play Console after the first upload: Setup → App signing. */
const FINGERPRINT = process.env.ANDROID_SIGNING_SHA256 ?? '';
const PACKAGE = process.env.ANDROID_PACKAGE_NAME ?? 'com.takatracker.app';

export function GET(): Response {
  const statements = FINGERPRINT
    ? [
        {
          relation: ['delegate_permission/common.handle_all_urls'],
          target: {
            namespace: 'android_app',
            package_name: PACKAGE,
            sha256_cert_fingerprints: [FINGERPRINT],
          },
        },
      ]
    : [];

  return new Response(JSON.stringify(statements, null, 2), {
    headers: {
      'content-type': 'application/json',
      /* Chrome caches this hard and a wrong answer is expensive to undo, so it
         stays short-lived while the value can still change. */
      'cache-control': 'public, max-age=300',
    },
  });
}
