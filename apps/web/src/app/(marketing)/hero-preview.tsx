'use client';

import * as React from 'react';
import { House, Payslip, ShoppingBag } from '@/components/icons';

/**
 * The picture on the right of the hero: a month in the app, with the notes and
 * coins it is about.
 *
 * Decoration, not content — every number in it is an example, so the whole
 * figure is hidden from assistive technology and the page's real claims stay in
 * the text beside it. The one moving part is the balance counting up to its
 * figure once, after the notes fan out; a reader who asked for reduced motion
 * gets the final figure straight away.
 */

const COPY = {
  bn: {
    month: 'এই মাস',
    left: 'এই মাসে হাতে আছে',
    rows: [
      ['বেতন', 'ব্যাংক', '+ ৪৫,০০০'],
      ['বাসা ভাড়া', 'ব্যাংক', '− ১৮,০০০'],
      ['বাজার', 'বিকাশ', '− ৫,৬২০'],
    ],
  },
  en: {
    month: 'This month',
    left: 'Left this month',
    rows: [
      ['Salary', 'Bank', '+ 45,000'],
      ['Rent', 'Bank', '− 18,000'],
      ['Groceries', 'bKash', '− 5,620'],
    ],
  },
} as const;

const TARGET = 21_380;
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';

function format(n: number, isBn: boolean): string {
  const grouped = n.toLocaleString('en-IN');
  return isBn ? grouped.replace(/[0-9]/g, (d) => BN_DIGITS[Number(d)]!) : grouped;
}

/* The server renders the final figure, so a reader without JavaScript — or
   before it arrives — sees ৳21,380 rather than ৳0. Once hydrated, and only if
   motion is welcome, it drops to zero and counts back up while the card is
   still rising. */
function useCountUp(target: number, delay: number, duration: number): number {
  const [value, setValue] = React.useState(target);
  React.useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setValue(0);
    let frame = 0;
    const start = performance.now() + delay;
    const tick = (now: number) => {
      const p = Math.min(1, Math.max(0, (now - start) / duration));
      // An illustration counting up, not money arithmetic; floor lands exactly
      // on the target when p reaches 1.
      setValue(Math.floor(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, delay, duration]);
  return value;
}

const ROW_ICON = [Payslip, House, ShoppingBag] as const;

export function HeroPreview({ locale }: { locale: 'bn' | 'en' }) {
  const isBn = locale === 'bn';
  const copy = COPY[locale];
  const balance = useCountUp(TARGET, 500, 1250);

  return (
    <div aria-hidden className="relative mx-auto w-full max-w-[540px] pt-24 sm:pt-28">
      <Notes isBn={isBn} />

      <div className="tt-rise bg-surface relative rounded-t-[32px] px-6 pb-5 pt-6 sm:px-7">
        <div className="flex items-center justify-between gap-3">
          <span className="text-ink text-[15px] font-semibold">{copy.month}</span>
          {/* Said out loud, because every figure in this card is invented. */}
          <span className="bg-brand-tint text-brand-strong rounded-full px-3 py-1 text-xs font-semibold">
            {isBn ? 'উদাহরণ' : 'Example'}
          </span>
        </div>
        <p className="text-ink-muted mt-4 text-sm">{copy.left}</p>
        <p className="text-ink mt-0.5 text-[44px] font-extrabold tabular-nums leading-tight sm:text-[52px]">
          ৳{format(balance, isBn)}
        </p>
        <span className="tt-goldbar bg-gold mt-2 block h-[7px] w-20 rounded-full" />

        <ul className="border-rule mt-5 border-t">
          {copy.rows.map(([title, account, amount], i) => {
            const Icon = ROW_ICON[i]!;
            const income = amount.startsWith('+');
            return (
              <li
                key={title}
                className="border-rule flex items-center gap-3.5 border-b py-3 last:border-b-0"
              >
                <span
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-[13px] ${
                    income ? 'bg-brand-tint text-brand' : 'bg-expense/10 text-expense'
                  }`}
                >
                  <Icon className="h-6 w-6" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="text-ink block text-[15px] font-semibold">{title}</span>
                  <span className="text-ink-muted block text-xs">{account}</span>
                </span>
                <span
                  className={`text-[15px] font-bold tabular-nums ${income ? 'text-income' : 'text-expense'}`}
                >
                  {amount}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <Coins />
    </div>
  );
}

/** Three notes fanned behind the card: a red ৳১০০, a green ৳৫০০ with its gold
    thread, and a dollar behind them. The product's own designs — neither is a
    picture of a real banknote. */
export function Notes({ isBn, className }: { isBn: boolean; className?: string }) {
  const hundred = isBn ? '১০০' : '100';
  const fiveHundred = isBn ? '৫০০' : '500';
  return (
    <svg
      viewBox="0 0 340 250"
      className={
        className ?? 'absolute -right-3 top-0 w-[230px] overflow-visible sm:-right-6 sm:w-[340px]'
      }
    >
      <defs>
        <pattern
          id="tt-note-r"
          width="5"
          height="5"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(40)"
        >
          <line
            x1="0"
            y1="0"
            x2="0"
            y2="5"
            stroke="#B23A3A"
            strokeWidth="0.6"
            strokeOpacity="0.45"
          />
        </pattern>
        <pattern
          id="tt-note-g"
          width="5"
          height="5"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(-35)"
        >
          <line
            x1="0"
            y1="0"
            x2="0"
            y2="5"
            stroke="#2F7A55"
            strokeWidth="0.6"
            strokeOpacity="0.5"
          />
        </pattern>
        <pattern
          id="tt-note-u"
          width="6"
          height="6"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(20)"
        >
          <line
            x1="0"
            y1="0"
            x2="0"
            y2="6"
            stroke="#5B7D66"
            strokeWidth="0.6"
            strokeOpacity="0.45"
          />
        </pattern>
      </defs>
      <g transform="translate(176 22) rotate(16)">
        <g className="tt-fan" style={{ animationDelay: '0.35s' }}>
          <rect width="160" height="78" rx="6" fill="#E2EAE3" />
          <rect width="160" height="78" rx="6" fill="url(#tt-note-u)" />
          <rect x="7" y="7" width="146" height="64" rx="3" fill="none" stroke="#5B7D66" />
          <circle cx="118" cy="39" r="23" fill="#F0F5F0" stroke="#5B7D66" strokeWidth="0.9" />
          <text x="118" y="50" textAnchor="middle" fontWeight="700" fontSize="30" fill="#4A6B55">
            $
          </text>
          <text x="18" y="30" fontWeight="700" fontSize="14" fill="#4A6B55" letterSpacing="1.5">
            USD
          </text>
        </g>
      </g>
      <g transform="translate(38 40) rotate(-12)">
        <g className="tt-fan" style={{ animationDelay: '0.5s' }}>
          <rect width="170" height="82" rx="6" fill="#F8DCDA" />
          <rect width="170" height="82" rx="6" fill="url(#tt-note-r)" />
          <rect
            x="7"
            y="7"
            width="156"
            height="68"
            rx="3"
            fill="none"
            stroke="#C62828"
            strokeWidth="1.1"
          />
          <circle cx="128" cy="41" r="24" fill="#FDEEEE" stroke="#C62828" strokeWidth="0.9" />
          <text x="128" y="51" textAnchor="middle" fontWeight="700" fontSize="28" fill="#8E1F1F">
            ৳
          </text>
          <text x="18" y="52" fontWeight="800" fontSize="30" fill="#8E1F1F">
            {hundred}
          </text>
        </g>
      </g>
      <g transform="translate(96 78) rotate(3)">
        <g className="tt-fan" style={{ animationDelay: '0.65s' }}>
          <rect width="184" height="88" rx="6" fill="#D4EADB" />
          <rect width="184" height="88" rx="6" fill="url(#tt-note-g)" />
          <rect
            x="7"
            y="7"
            width="170"
            height="74"
            rx="3"
            fill="none"
            stroke="#1F6F4A"
            strokeWidth="1.2"
          />
          <rect x="104" width="7" height="88" fill="#C8892C" fillOpacity="0.85" />
          <circle cx="146" cy="44" r="25" fill="#ECF6EF" stroke="#1F6F4A" />
          <text x="146" y="55" textAnchor="middle" fontWeight="700" fontSize="30" fill="#154D33">
            ৳
          </text>
          <text x="18" y="56" fontWeight="800" fontSize="32" fill="#154D33">
            {fiveHundred}
          </text>
        </g>
      </g>
    </svg>
  );
}

function Coins() {
  return (
    <svg
      viewBox="0 0 170 110"
      className="absolute left-1 top-2 hidden w-[150px] overflow-visible sm:block"
    >
      <defs>
        <radialGradient id="tt-coin-gold" cx="0.36" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#FBEAC4" />
          <stop offset="0.55" stopColor="#D9A24A" />
          <stop offset="1" stopColor="#9A6516" />
        </radialGradient>
        <radialGradient id="tt-coin-steel" cx="0.36" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#F5F7F9" />
          <stop offset="0.6" stopColor="#C3CAD1" />
          <stop offset="1" stopColor="#8A949E" />
        </radialGradient>
      </defs>
      <g transform="translate(52 56)">
        <g className="tt-coin" style={{ animationDelay: '0.9s' }}>
          <circle r="34" fill="url(#tt-coin-gold)" />
          <circle r="29" fill="none" stroke="#8F5F14" strokeDasharray="1.4 1.8" />
          <circle r="22" fill="none" stroke="#B37A22" />
          <text y="9" textAnchor="middle" fontWeight="800" fontSize="24" fill="#6E480C">
            ৳৫
          </text>
        </g>
      </g>
      <g transform="translate(112 78)">
        <g className="tt-coin" style={{ animationDelay: '1.05s' }}>
          <circle r="26" fill="url(#tt-coin-steel)" />
          <circle r="22" fill="none" stroke="#7B858F" strokeWidth="0.9" strokeDasharray="1.3 1.7" />
          <text y="8" textAnchor="middle" fontWeight="700" fontSize="19" fill="#57616B">
            ৳২
          </text>
        </g>
      </g>
      <g transform="translate(126 26)">
        <g className="tt-coin" style={{ animationDelay: '1.2s' }}>
          <circle r="18" fill="url(#tt-coin-gold)" />
          <circle r="15" fill="none" stroke="#8F5F14" strokeWidth="0.9" strokeDasharray="1.2 1.6" />
          <text y="6" textAnchor="middle" fontWeight="700" fontSize="14" fill="#6E480C">
            ৳১
          </text>
        </g>
      </g>
    </svg>
  );
}
