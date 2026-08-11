import type { DeviceKind } from '@hishab/shared';

/**
 * How to put Taka Tracker on a phone, per device, with the screen drawn.
 *
 * Three sets of instructions rather than one, because "add to home screen" is
 * three different journeys and the wrong one is worse than no instructions at
 * all: iOS hides it behind the Share sheet, Android behind the ⋮ overflow menu,
 * and a desktop browser behind an icon that lives inside the address bar. A
 * person following the wrong list concludes the feature does not exist.
 *
 * The mockups are inline SVG rather than screenshots. Screenshots of iOS and
 * Android go stale every autumn, weigh a few hundred kilobytes each, and cannot
 * follow the reader's colour scheme; a drawing of *where the button is* stays
 * true across versions and costs nothing. It is deliberately a diagram and not
 * a fake screenshot — pretending to be a real iOS screen would be a small lie
 * that makes the next difference confusing.
 */

export interface Step {
  title: string;
  body: string;
  /** Which frame to draw beside this step, if any. */
  art?: 'share' | 'overflow' | 'address-bar' | 'home';
}

export interface DeviceGuide {
  kind: DeviceKind;
  label: string;
  labelEn: string;
  /** The browser these steps assume, said out loud — see `caveat`. */
  browser: string;
  caveat: string;
  steps: Step[];
}

export const GUIDES: DeviceGuide[] = [
  {
    kind: 'IOS',
    label: 'আইফোন / আইপ্যাড',
    labelEn: 'iPhone or iPad',
    browser: 'Safari',
    /* Not a footnote. On iOS only Safari can add to the home screen — Chrome
       and Firefox on an iPhone are Safari underneath but do not expose the
       option — and somebody following these steps in Chrome will look for a
       button that is not there and give up. */
    caveat:
      'আইফোনে শুধু Safari থেকেই হোম স্ক্রিনে যোগ করা যায়। Chrome বা Firefox দিয়ে খুললে অপশনটি পাবেন না — লিংকটি Safari-তে খুলুন।',
    steps: [
      {
        title: 'Safari-তে takatracker.com খুলুন',
        body: 'ঠিকানার ঘরে takatracker.com লিখে যান, অথবা লগইন করে নিন। যেকোনো পাতা থাকলেই চলবে।',
      },
      {
        title: 'নিচের শেয়ার বোতামে চাপ দিন',
        body: 'পর্দার নিচে মাঝখানে বর্গাকার আইকন, উপরে তীর চিহ্ন — ওটাই শেয়ার।',
        art: 'share',
      },
      {
        title: 'তালিকা থেকে "Add to Home Screen" বাছুন',
        body: 'একটু নিচে স্ক্রল করলে পাবেন। বাংলা ফোনে লেখা থাকতে পারে "হোম স্ক্রিনে যোগ করুন"।',
      },
      {
        title: 'উপরের ডানে "Add" চাপুন',
        body: 'নাম বদলাতে চাইলে এখানেই পারবেন। এরপর হোম স্ক্রিনে আইকনটি বসে যাবে।',
        art: 'home',
      },
    ],
  },
  {
    kind: 'ANDROID',
    label: 'অ্যান্ড্রয়েড ফোন',
    labelEn: 'Android phone',
    browser: 'Chrome',
    caveat:
      'Chrome-এ অনেক সময় নিজে থেকেই "অ্যাপ ইনস্টল করুন" লেখা একটি বার নিচে ভেসে ওঠে — সেটি এলে শুধু চাপ দিলেই হবে, নিচের ধাপগুলো লাগবে না।',
    steps: [
      {
        title: 'Chrome-এ takatracker.com খুলুন',
        body: 'ঠিকানার ঘরে takatracker.com লিখে যান, অথবা লগইন করে নিন।',
      },
      {
        title: 'উপরের ডানে তিন ফোঁটার মেনুতে চাপ দিন',
        body: 'ঠিকানার ঘরের ডান পাশে উল্লম্বভাবে তিনটি বিন্দু (⋮)।',
        art: 'overflow',
      },
      {
        title: '"Install app" বা "Add to Home screen" বাছুন',
        body: 'ফোনভেদে দুটোর যেকোনো একটি লেখা থাকে — কাজ একই।',
      },
      {
        title: '"Install" চাপুন',
        body: 'আইকনটি হোম স্ক্রিনে বসবে এবং অ্যাপের মতোই আলাদা উইন্ডোতে খুলবে।',
        art: 'home',
      },
    ],
  },
  {
    kind: 'DESKTOP',
    label: 'কম্পিউটার',
    labelEn: 'Computer',
    browser: 'Chrome বা Edge',
    caveat:
      'Firefox আর Safari ডেস্কটপে এখনো অ্যাপ হিসেবে ইনস্টল করতে দেয় না। ওগুলোয় সাধারণ বুকমার্ক করে রাখুন — সব ফিচার একইভাবে কাজ করবে।',
    steps: [
      {
        title: 'Chrome বা Edge-এ takatracker.com খুলুন',
        body: 'লগইন করা থাকলে সরাসরি ড্যাশবোর্ড আসবে।',
      },
      {
        title: 'ঠিকানার ঘরের ডানে ইনস্টল আইকনে ক্লিক করুন',
        body: 'ছোট একটি পর্দা আর নিচমুখী তীরের আইকন। না দেখলে ⋮ মেনু থেকে "Install Taka Tracker"।',
        art: 'address-bar',
      },
      {
        title: '"Install" চাপুন',
        body: 'আলাদা উইন্ডোতে খুলবে, ট্যাব-বার ছাড়া — ডেস্কটপ অ্যাপের মতোই।',
      },
    ],
  },
];

export const guideFor = (kind: DeviceKind): DeviceGuide =>
  GUIDES.find((g) => g.kind === kind) ?? GUIDES[0]!;

/**
 * A phone drawn with the one control the step is about picked out.
 *
 * `aria-hidden`, because every one of these repeats what the step's own
 * sentence already says — a screen reader announcing "rectangle, arrow" adds
 * nothing to "chap din the share button at the bottom".
 */
export function StepArt({ art }: { art: NonNullable<Step['art']> }) {
  const frame = (
    <>
      <rect
        x="8"
        y="4"
        width="104"
        height="184"
        rx="14"
        className="fill-[var(--hishab-surface)] stroke-[var(--hishab-rule)]"
        strokeWidth="2"
      />
      <rect x="44" y="8" width="32" height="5" rx="2.5" className="fill-[var(--hishab-rule)]" />
    </>
  );

  const highlight = 'fill-[var(--hishab-income)]';
  const faint = 'fill-[var(--hishab-greenbar)]';

  return (
    <svg
      viewBox="0 0 120 192"
      role="img"
      aria-hidden
      className="h-40 w-auto shrink-0"
      focusable="false"
    >
      {frame}

      {art === 'share' ? (
        <>
          {/* Content placeholder, then the Safari toolbar with Share ringed. */}
          <rect x="18" y="24" width="84" height="8" rx="4" className={faint} />
          <rect x="18" y="40" width="60" height="8" rx="4" className={faint} />
          <rect x="18" y="56" width="72" height="8" rx="4" className={faint} />
          <line x1="8" y1="158" x2="112" y2="158" className="stroke-[var(--hishab-rule)]" />
          <circle
            cx="60"
            cy="172"
            r="13"
            className="fill-none stroke-[var(--hishab-income)]"
            strokeWidth="2"
          />
          <path
            d="M60 166v12M60 166l-4 4M60 166l4 4M53 176v4h14v-4"
            className="stroke-[var(--hishab-income)]"
            strokeWidth="2"
            fill="none"
            strokeLinecap="round"
          />
        </>
      ) : null}

      {art === 'overflow' ? (
        <>
          {/* Chrome's address bar with the ⋮ overflow ringed at the right. */}
          <rect x="16" y="22" width="72" height="12" rx="6" className={faint} />
          <circle
            cx="99"
            cy="28"
            r="11"
            className="fill-none stroke-[var(--hishab-income)]"
            strokeWidth="2"
          />
          <circle cx="99" cy="23" r="1.6" className={highlight} />
          <circle cx="99" cy="28" r="1.6" className={highlight} />
          <circle cx="99" cy="33" r="1.6" className={highlight} />
          <rect x="18" y="48" width="84" height="8" rx="4" className={faint} />
          <rect x="18" y="64" width="60" height="8" rx="4" className={faint} />
        </>
      ) : null}

      {art === 'address-bar' ? (
        <>
          <rect x="16" y="22" width="62" height="12" rx="6" className={faint} />
          <circle
            cx="90"
            cy="28"
            r="11"
            className="fill-none stroke-[var(--hishab-income)]"
            strokeWidth="2"
          />
          <rect
            x="85"
            y="23"
            width="10"
            height="8"
            rx="1.5"
            className="fill-none stroke-[var(--hishab-income)]"
            strokeWidth="1.6"
          />
          <path
            d="M90 25v5M90 30l-2.2-2.2M90 30l2.2-2.2"
            className="stroke-[var(--hishab-income)]"
            strokeWidth="1.6"
            fill="none"
            strokeLinecap="round"
          />
          <rect x="18" y="48" width="84" height="8" rx="4" className={faint} />
        </>
      ) : null}

      {art === 'home' ? (
        <>
          {/* The finished state: the icon sitting on a home screen. */}
          <rect x="20" y="28" width="24" height="24" rx="6" className={faint} />
          <rect x="48" y="28" width="24" height="24" rx="6" className={faint} />
          <g>
            <rect x="76" y="28" width="24" height="24" rx="6" className={highlight} />
            <text
              x="88"
              y="45"
              textAnchor="middle"
              className="fill-white"
              style={{ fontSize: 13, fontWeight: 700 }}
            >
              ৳
            </text>
          </g>
          <rect x="76" y="56" width="24" height="4" rx="2" className={faint} />
          <rect x="20" y="70" width="24" height="24" rx="6" className={faint} />
          <rect x="48" y="70" width="24" height="24" rx="6" className={faint} />
        </>
      ) : null}
    </svg>
  );
}
