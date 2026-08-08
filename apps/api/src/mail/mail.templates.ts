import type { MailMessage } from './mail.transport';

/**
 * Bengali transactional email bodies.
 *
 * Plain text is authoritative — it is what a Bangladeshi user on a cheap mail
 * client actually reads, and the link must be usable by copy-paste from it. The
 * HTML part is a minimal, inline-styled courtesy with no images, no tracking
 * pixel and no external stylesheet, so it renders the same in Gmail, Outlook
 * and a webmail from 2009.
 */

const BRAND = 'হিসাব';

/** Anything interpolated into the HTML part is escaped. Names come from users. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface Layout {
  heading: string;
  lines: string[];
  action?: { label: string; url: string };
  footer: string[];
}

function render(layout: Layout): { text: string; html: string } {
  const text = [
    layout.heading,
    '',
    ...layout.lines,
    ...(layout.action ? ['', layout.action.url] : []),
    '',
    ...layout.footer,
    '',
    `— ${BRAND}`,
  ].join('\n');

  const html = [
    "<div style=\"font-family:system-ui,-apple-system,'Noto Sans Bengali',sans-serif;",
    'font-size:15px;line-height:1.7;color:#111;max-width:520px;margin:0 auto;padding:24px">',
    `<h2 style="font-size:18px;margin:0 0 16px">${escapeHtml(layout.heading)}</h2>`,
    ...layout.lines.map((line) => `<p style="margin:0 0 12px">${escapeHtml(line)}</p>`),
    layout.action
      ? `<p style="margin:24px 0"><a href="${escapeHtml(layout.action.url)}" ` +
        'style="background:#0f766e;color:#fff;text-decoration:none;padding:10px 18px;' +
        `border-radius:6px;display:inline-block">${escapeHtml(layout.action.label)}</a></p>` +
        '<p style="margin:0 0 12px;font-size:13px;color:#555">বাটন কাজ না করলে এই ঠিকানাটি ' +
        `ব্রাউজারে পেস্ট করুন:<br><span style="word-break:break-all">${escapeHtml(layout.action.url)}</span></p>`
      : '',
    '<hr style="border:none;border-top:1px solid #e5e5e5;margin:24px 0">',
    ...layout.footer.map(
      (line) => `<p style="margin:0 0 8px;font-size:13px;color:#555">${escapeHtml(line)}</p>`,
    ),
    `<p style="margin:16px 0 0;font-size:13px;color:#555">— ${BRAND}</p>`,
    '</div>',
  ]
    .filter(Boolean)
    .join('');

  return { text, html };
}

export function verificationEmail(params: {
  to: string;
  name: string;
  url: string;
  expiresInHours: number;
}): MailMessage {
  const { text, html } = render({
    heading: 'আপনার ইমেইল ঠিকানা যাচাই করুন',
    lines: [
      `আসসালামু আলাইকুম ${params.name},`,
      `${BRAND}-এ আপনার ইমেইল ঠিকানা নিশ্চিত করতে নিচের লিংকে ক্লিক করুন।`,
    ],
    action: { label: 'ইমেইল যাচাই করুন', url: params.url },
    footer: [
      `লিংকটি ${toBengaliDigits(params.expiresInHours)} ঘণ্টা পর্যন্ত কাজ করবে এবং একবারই ব্যবহার করা যাবে।`,
      'আপনি যদি এই অ্যাকাউন্ট না খুলে থাকেন, এই মেইলটি উপেক্ষা করুন।',
    ],
  });

  return { to: params.to, subject: `${BRAND} — ইমেইল যাচাই করুন`, text, html };
}

export function passwordResetEmail(params: {
  to: string;
  name: string;
  url: string;
  expiresInMinutes: number;
}): MailMessage {
  const { text, html } = render({
    heading: 'পাসওয়ার্ড রিসেট করুন',
    lines: [
      `আসসালামু আলাইকুম ${params.name},`,
      `${BRAND}-এ আপনার পাসওয়ার্ড রিসেট করার অনুরোধ পেয়েছি। নতুন পাসওয়ার্ড দিতে নিচের লিংকে ক্লিক করুন।`,
    ],
    action: { label: 'নতুন পাসওয়ার্ড দিন', url: params.url },
    footer: [
      `নিরাপত্তার জন্য লিংকটি মাত্র ${toBengaliDigits(params.expiresInMinutes)} মিনিট কাজ করবে এবং একবারই ব্যবহার করা যাবে।`,
      'আপনি অনুরোধ না করে থাকলে কিছুই করার দরকার নেই — আপনার পাসওয়ার্ড অপরিবর্তিত থাকবে।',
    ],
  });

  return { to: params.to, subject: `${BRAND} — পাসওয়ার্ড রিসেট`, text, html };
}

/**
 * Sent after a reset succeeds. This is the only warning a user gets if somebody
 * else reset their password, so it goes out even though nothing is asked of
 * them — and it never contains a link that could itself be abused.
 */
export function passwordChangedEmail(params: { to: string; name: string }): MailMessage {
  const { text, html } = render({
    heading: 'আপনার পাসওয়ার্ড পরিবর্তন করা হয়েছে',
    lines: [
      `আসসালামু আলাইকুম ${params.name},`,
      `${BRAND}-এ আপনার পাসওয়ার্ড এইমাত্র পরিবর্তন করা হয়েছে এবং সব ডিভাইস থেকে লগআউট করা হয়েছে।`,
    ],
    footer: ['এটি আপনি না করে থাকলে এখনই "পাসওয়ার্ড ভুলে গেছি" দিয়ে নতুন পাসওয়ার্ড সেট করুন।'],
  });

  return { to: params.to, subject: `${BRAND} — পাসওয়ার্ড পরিবর্তন হয়েছে`, text, html };
}

const BENGALI_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];

/** Bengali copy with Latin numerals reads as a half-translated machine job. */
export function toBengaliDigits(value: number): string {
  return String(value).replace(/\d/g, (d) => BENGALI_DIGITS[Number(d)] ?? d);
}
