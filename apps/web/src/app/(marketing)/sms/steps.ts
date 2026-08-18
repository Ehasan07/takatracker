/**
 * Turning bank SMS into ledger entries, per phone.
 *
 * ## Why this page is public
 *
 * It is the one feature people ask about before signing up and the one they
 * cannot evaluate from a screenshot: "will I still be typing every transaction
 * by hand?" The honest answer is a list of steps somebody can read *before*
 * they have an account, decide is doable on their own phone, and then follow.
 * So it lives on the marketing site rather than only behind the login, and the
 * steps are in the server HTML rather than in a tab that has to be clicked.
 *
 * ## Why two lists and not one
 *
 * Android and iPhone are two different journeys and the wrong one is worse than
 * none: Android needs a third-party forwarder from the Play Store, iOS has no
 * such app worth trusting with bank messages and goes through Apple's own
 * Shortcuts automation instead. A person following the wrong list concludes the
 * feature does not work.
 *
 * The Android steps deliberately name *fields* rather than one app's menu path.
 * The Play Store has a dozen of these, they come and go, and a guide pinned to
 * one app's third screen is wrong within a year.
 *
 * ## What this page must never contain
 *
 * A real workspace id or secret. Both are per-workspace and are shown inside
 * the app, on the settings screen, where they can be copied. Anything printed
 * here would be an invitation to paste somebody else's.
 */

export interface SmsStep {
  title: string;
  /** Plain text: this also becomes `HowToStep.text` in the structured data. */
  body: string;
}

export interface SmsGuide {
  kind: 'ANDROID' | 'IOS';
  label: string;
  /** The tool the steps assume, named out loud so a reader can check they have it. */
  tool: string;
  intro: string;
  steps: SmsStep[];
  caveat: string;
}

export interface SmsContent {
  title: string;
  intro: string;
  /** Why a forwarded message is not the same as giving away bank access. */
  safetyHeading: string;
  safety: string[];
  guides: SmsGuide[];
  reviewHeading: string;
  review: string[];
  troubleHeading: string;
  trouble: { q: string; a: string }[];
  ctaHeading: string;
  cta: string;
  ctaButton: string;
}

const ANDROID_BN: SmsGuide = {
  kind: 'ANDROID',
  label: 'অ্যান্ড্রয়েড',
  tool: 'প্লে স্টোরের একটি SMS ফরওয়ার্ডার অ্যাপ',
  intro:
    'অ্যান্ড্রয়েডে একটি ছোট অ্যাপ লাগে যেটি নির্দিষ্ট নম্বর থেকে আসা বার্তা একটি ঠিকানায় পাঠিয়ে দেয়। প্লে স্টোরে এরকম অনেকগুলো আছে; নিচের ঘরগুলো সবকটিতেই থাকে, নাম আলাদা হতে পারে।',
  steps: [
    {
      title: 'ঠিকানা আর দুটি চাবি কপি করুন',
      body: 'Taka Tracker খুলে সেটিংস → এসএমএস ইনবক্স-এ যান। সেখানে একটি ঠিকানা আর দুই জোড়া নাম-মান আছে — একটি ওয়ার্কস্পেস আইডি, আরেকটি সিক্রেট। তিনটিই কপি করার বোতাম আছে। এগুলো আপনার নিজের, কাউকে দেবেন না।',
    },
    {
      title: 'ফরওয়ার্ডার অ্যাপ নামান',
      body: 'প্লে স্টোরে খুঁজুন “SMS Forwarder” বা “SMS to URL Forwarder”। যেটি ওয়েবহুক বা URL-এ পাঠাতে পারে এবং হেডার বসাতে দেয়, সেটিই চলবে।',
    },
    {
      title: 'নতুন নিয়ম বানান',
      body: 'অ্যাপে একটি নতুন rule বা forwarder যোগ করুন। পাঠানোর ধরন হিসেবে ওয়েবহুক বা URL বেছে নিন — ইমেইল বা অন্য নম্বরে নয়।',
    },
    {
      title: 'ঠিকানা ও পদ্ধতি বসান',
      body: 'URL-এর ঘরে কপি করা ঠিকানাটি বসান। Method রাখুন POST, আর Content-Type রাখুন application/json।',
    },
    {
      title: 'দুটি হেডার বসান',
      body: 'Headers অংশে দুই জোড়া নাম ও মান হুবহু বসান — বাঁ পাশে নাম, ডান পাশে মান। একটি অক্ষর ভুল হলেও বার্তা গ্রহণ করা হবে না, আর সাড়া আসবে 401।',
    },
    {
      title: 'বার্তার ঘর',
      body: 'Body-তে অ্যাপে দেখানো JSON-টি বসান। যেখানে বার্তার লেখা বসার কথা, সেখানে ফরওয়ার্ডার অ্যাপের নিজের টোকেন দিন — কোনো অ্যাপে %text%, কোনোটিতে {{message}}। কোন টোকেন, সেটি ওই অ্যাপের নিজের সাহায্যে লেখা থাকে।',
    },
    {
      title: 'কোন নম্বরগুলো পাঠাবে',
      body: 'শুধু ব্যাংক, বিকাশ, নগদ বা রকেটের শর্টকোডগুলো বেছে দিন। সব এসএমএস পাঠালে ইনবক্স ওটিপি আর বিজ্ঞাপনে ভরে যাবে, আর দরকারি খসড়াগুলো তার নিচে চাপা পড়বে।',
    },
    {
      title: 'একবার পরীক্ষা করুন',
      body: 'অ্যাপ থেকে একটি বার্তা পাঠান। Taka Tracker-এর এসএমএস ইনবক্সে সেটি খসড়া হয়ে আসবে। একই বার্তা দুইবার গেলে দ্বিতীয়বার নতুন করে কিছু যোগ হবে না — একই লেনদেন দুইবার বসার ভয় নেই।',
    },
  ],
  caveat:
    'ফোনে ইন্টারনেট না থাকলে বার্তাটি তখন পাঠানো যাবে না; বেশিরভাগ ফরওয়ার্ডার অ্যাপ পরে আবার চেষ্টা করে। ব্যাটারি সেভারে অ্যাপটি বন্ধ হয়ে যেতে পারে — সেটিংসে ওই অ্যাপটিকে “Unrestricted” করে রাখলে ভালো।',
};

const IOS_BN: SmsGuide = {
  kind: 'IOS',
  label: 'আইফোন ও আইপ্যাড',
  tool: 'অ্যাপলের নিজের Shortcuts অ্যাপ',
  intro:
    'আইফোনে ব্যাংকের বার্তা পড়তে পারে এমন কোনো তৃতীয় পক্ষের অ্যাপ ভরসা করার মতো নেই — আইওএস সেটি হতেই দেয় না, আর দিলেও ব্যাংকের বার্তা এমন কাউকে দেওয়া উচিত নয়। বদলে অ্যাপলের নিজের Shortcuts দিয়েই হয়। ধাপ কয়েকটা বেশি, কিন্তু একবারের কাজ।',
  steps: [
    {
      title: 'ঠিকানা আর দুটি চাবি কপি করুন',
      body: 'Taka Tracker খুলে সেটিংস → এসএমএস ইনবক্স-এ যান। ঠিকানা, ওয়ার্কস্পেস আইডি আর সিক্রেট — তিনটিই কপি করে রাখুন।',
    },
    {
      title: 'অটোমেশন খুলুন',
      body: 'Shortcuts অ্যাপ খুলুন → নিচে Automation → + → নিচে নেমে Message বেছে নিন।',
    },
    {
      title: 'কখন চলবে',
      body: 'Message Contains ঘরে ব্যাংকের বার্তায় থাকে এমন একটি শব্দ দিন — যেমন BDT বা Tk। ঘরটি খালি রাখলে অটোমেশন চালুই হবে না। নিচে Run Immediately বেছে নিন, নাহলে প্রতিবার হাতে অনুমতি দিতে হবে।',
    },
    {
      title: 'অ্যাকশন যোগ করুন',
      body: 'Next → New Blank Automation → খোঁজার ঘরে Get Contents of URL লিখে সেটি যোগ করুন।',
    },
    {
      title: 'ঠিকানা',
      body: 'URL ঘরে কপি করা ঠিকানাটি বসান। কোনো IP বা পোর্ট নয় — ঠিকানাটি https:// দিয়ে শুরু হতে হবে, কারণ সিক্রেটটি সাথে যায় আর সাধারণ http-এ সেটি খোলা তারে চলে যাবে।',
    },
    {
      title: 'Method',
      body: 'Get Contents of-এর পাশের তীরটিতে চাপ দিন। Method করুন POST।',
    },
    {
      title: 'পাঁচটি ঘর',
      body: 'Request Body করুন JSON আর Headers খালি রাখুন। পাঁচটি ঘর যোগ করুন — workspace ও secret (কপি করা দুটি মান), channel = SMS, sender = বার্তা পাঠানো নম্বর, আর body-তে Shortcut Input ভেরিয়েবলটি। ওই নীল চিপটি কীবোর্ডের উপরে পাবেন; ওটার ভেতরেই আসল বার্তা থাকে।',
    },
    {
      title: 'হেডার দিয়েও করা যায়',
      body: 'হেডার পছন্দ হলে workspace আর secret ঘর দুটি বাদ দিয়ে ওই দুই জোড়া নাম-মান Headers-এ বসান। বাঁ পাশে নাম, ডান পাশে মান — উল্টে গেলে সাড়া আসবে 401।',
    },
    {
      title: 'একবার পরীক্ষা করুন',
      body: 'Done চাপুন। নিজের নম্বরে “BDT 100 test” লিখে একটি বার্তা পাঠান — সেটি এসএমএস ইনবক্সে খসড়া হয়ে আসবে।',
    },
  ],
  caveat:
    'আইফোনের অটোমেশন কেবল Messages অ্যাপে আসা বার্তাতেই চলে। WhatsApp, ইমো বা অন্য অ্যাপের বার্তা এভাবে পাঠানো যায় না। ফোন লক থাকলেও চলে।',
};

export const SMS_BN: SmsContent = {
  title: 'ব্যাংকের এসএমএস থেকে সরাসরি হিসাব',
  intro:
    'বিকাশ, নগদ বা ব্যাংক থেকে যে বার্তাটি আসে তাতে তারিখ, টাকার অঙ্ক আর কোন অ্যাকাউন্ট — সবই লেখা থাকে। সেই বার্তাটি Taka Tracker-এ পাঠিয়ে দিলে খসড়া তৈরি হয়ে যায়; আপনি শুধু দেখে নিয়ে “যোগ করুন” চাপেন। হাতে টাইপ করার দরকার পড়ে না।',
  safetyHeading: 'এটা ব্যাংকের সাথে যুক্ত হওয়া নয়',
  safety: [
    'আপনার ব্যাংকের পাসওয়ার্ড, পিন বা ওটিপি কখনো চাওয়া হয় না। যে বার্তাগুলো আপনি নিজে পাঠাবেন, শুধু সেগুলোই আসে।',
    'কোনো ব্যাংকের সাথে আমাদের সংযোগ নেই। ব্যাংক জানেও না এই অ্যাপ আছে — বার্তাটি আপনার ফোন থেকে যায়, ব্যাংক থেকে নয়।',
    'কোন নম্বরগুলোর বার্তা যাবে সেটা আপনি ঠিক করেন, আর যেকোনো সময় বন্ধ করে দিতে পারেন।',
    'বার্তা এলেই খাতায় কিছু বসে না। প্রতিটি খসড়া আপনি না দেখা পর্যন্ত অপেক্ষা করে — অ্যাপ নিজে থেকে কোনো লেনদেন লেখে না।',
    'সিক্রেটটি আপনার নিজের ওয়ার্কস্পেসের। অন্য কারো বার্তা আপনার খাতায় ঢুকতে পারে না, আপনারটিও অন্য কারো খাতায় যেতে পারে না।',
  ],
  guides: [ANDROID_BN, IOS_BN],
  reviewHeading: 'বার্তা আসার পর',
  review: [
    'খসড়ায় তারিখ, টাকার অঙ্ক আর কোন দিকে গেল — সবই বসানো থাকে, আর বার্তার কোন অংশ থেকে কোনটি পড়া হয়েছে তা দাগ দিয়ে দেখানো হয়। ভুল হলে বদলে নিতে পারবেন।',
    'খরচ, আয় নাকি ট্রান্সফার — তিনটি ট্যাব। ডিপিএসের কিস্তি বা কার্ডের বিল ট্রান্সফার, তাই সেগুলো আয়-ব্যয়ে যোগ হয় না।',
    'ডিপিএসে টাকা গেলে সেই মাসের কিস্তিটাও নিজে থেকে “জমা হয়েছে” হয়ে যায়, যদি অঙ্ক হুবহু মেলে।',
    'ডলারে কাটা বিল হলে কত টাকা কাটা হয়েছে সেটা জিজ্ঞেস করা হয় — কারণ ব্যাংক যে রেট কেটেছে সেটা কোথাও লেখা থাকে না।',
    'একই বার্তা দুইবার এলে দ্বিতীয়বার নতুন কিছু হয় না।',
  ],
  troubleHeading: 'কাজ না করলে',
  trouble: [
    {
      q: 'সাড়া আসছে 401',
      a: 'ওয়ার্কস্পেস আইডি বা সিক্রেটের কোনো একটি ভুল, অথবা নাম আর মান উল্টে বসেছে। সেটিংস থেকে আবার কপি করে বসান — হাতে টাইপ করবেন না।',
    },
    {
      q: 'ইনবক্সে কিছুই আসছে না',
      a: 'ফরওয়ার্ডার অ্যাপটি ওই নম্বরটিকে বেছে নিয়েছে কিনা দেখুন, আর ফোনের ব্যাটারি সেভার ওই অ্যাপটিকে বন্ধ করে রেখেছে কিনা দেখুন।',
    },
    {
      q: 'খসড়া আসছে কিন্তু টাকার অঙ্ক ফাঁকা',
      a: 'ওই ব্যাংকের বার্তার ছাঁচটি এখনো চেনানো হয়নি। অঙ্কটি হাতে বসিয়ে যোগ করে দিন, আর মতামত পাঠিয়ে বার্তাটি জানিয়ে দিন — ছাঁচটি যোগ করে দেওয়া হবে।',
    },
    {
      q: 'ওটিপি আর বিজ্ঞাপনে ইনবক্স ভরে যাচ্ছে',
      a: 'ফরওয়ার্ডারে শুধু ব্যাংক আর মোবাইল ব্যাংকিংয়ের শর্টকোডগুলো রাখুন, সব নম্বর নয়।',
    },
  ],
  ctaHeading: 'শুরু করবেন?',
  cta: 'অ্যাকাউন্ট খোলা ফ্রি, কার্ড লাগে না। ঠিকানা আর সিক্রেট সেটিংসেই পাবেন।',
  ctaButton: 'ফ্রি অ্যাকাউন্ট খুলুন',
};

const ANDROID_EN: SmsGuide = {
  kind: 'ANDROID',
  label: 'Android',
  tool: 'An SMS forwarder app from the Play Store',
  intro:
    'Android needs a small app that sends messages from chosen numbers on to a web address. The Play Store has several; the fields below exist in all of them, though the names vary.',
  steps: [
    {
      title: 'Copy the address and the two keys',
      body: 'In Taka Tracker open Settings → SMS inbox. There is an address and two name/value pairs — a workspace id and a secret. Each has a copy button. They are yours; do not share them.',
    },
    {
      title: 'Install a forwarder',
      body: 'Search the Play Store for "SMS Forwarder" or "SMS to URL Forwarder". Any app that can post to a webhook and set custom headers will do.',
    },
    {
      title: 'Create a rule',
      body: 'Add a new rule or forwarder and choose webhook or URL as the destination — not email and not another phone number.',
    },
    {
      title: 'Address and method',
      body: 'Paste the copied address into the URL field. Set Method to POST and Content-Type to application/json.',
    },
    {
      title: 'Two headers',
      body: 'Put the two name/value pairs into the Headers section exactly as shown — name on the left, value on the right. One wrong character and the message is refused with a 401.',
    },
    {
      title: 'The message body',
      body: 'Paste the JSON the app shows you. Where the message text belongs, use the forwarder app’s own token — %text% in some apps, {{message}} in others. Its own help page says which.',
    },
    {
      title: 'Choose which senders',
      body: 'Forward only your bank, bKash, Nagad or Rocket shortcodes. Forwarding everything fills the inbox with OTPs and marketing, and buries the drafts that matter.',
    },
    {
      title: 'Send one test',
      body: 'Send a test from the app. It arrives in the SMS inbox as a draft. Sending the same message twice adds nothing the second time, so no transaction can be recorded twice.',
    },
  ],
  caveat:
    'With no internet the message cannot be sent at that moment; most forwarders retry later. Battery savers can kill the app — mark it Unrestricted in Android’s battery settings.',
};

const IOS_EN: SmsGuide = {
  kind: 'IOS',
  label: 'iPhone and iPad',
  tool: 'Apple’s own Shortcuts app',
  intro:
    'There is no third-party iPhone app worth trusting with bank messages — iOS does not really allow one, and bank SMS should not be handed to a stranger anyway. Apple’s own Shortcuts does the job. A few more steps, but only once.',
  steps: [
    {
      title: 'Copy the address and the two keys',
      body: 'In Taka Tracker open Settings → SMS inbox and copy the address, the workspace id and the secret.',
    },
    {
      title: 'Open Automation',
      body: 'Open Shortcuts → Automation at the bottom → + → scroll down to Message.',
    },
    {
      title: 'When it runs',
      body: 'In Message Contains put a word your bank messages always carry — BDT or Tk. Left empty the automation never runs. Choose Run Immediately below, or you will be asked to approve every single message by hand.',
    },
    {
      title: 'Add the action',
      body: 'Next → New Blank Automation → search for Get Contents of URL and add it.',
    },
    {
      title: 'The address',
      body: 'Paste the copied address into the URL field. Not an IP and not a port — it must start with https://, because the secret travels with the request and plain http would put it on the wire in the clear.',
    },
    {
      title: 'Method',
      body: 'Tap the arrow beside Get Contents of. Set Method to POST.',
    },
    {
      title: 'Five fields',
      body: 'Set Request Body to JSON and leave Headers empty. Add five fields — workspace and secret (the two copied values), channel = SMS, sender = the number it came from, and body = the Shortcut Input variable. That blue chip sits above the keyboard, and it holds the actual message.',
    },
    {
      title: 'Headers work too',
      body: 'If you prefer headers, drop the workspace and secret fields and put those two name/value pairs in Headers instead. Name on the left, value on the right — swapped, the answer is 401.',
    },
    {
      title: 'Send one test',
      body: 'Tap Done, then text yourself "BDT 100 test". It arrives in the SMS inbox as a draft.',
    },
  ],
  caveat:
    'iPhone automations only fire for messages that arrive in the Messages app. WhatsApp, imo and the rest cannot be forwarded this way. The phone does not need to be unlocked.',
};

export const SMS_EN: SmsContent = {
  title: 'Turn bank SMS into bookkeeping',
  intro:
    'The message your bank, bKash or Nagad sends already carries the date, the amount and which account. Forward it to Taka Tracker and the entry is drafted for you — you read it and press add. Nothing is typed twice.',
  safetyHeading: 'This is not connecting your bank',
  safety: [
    'You are never asked for a banking password, PIN or OTP. Only the messages you choose to forward ever arrive.',
    'We have no connection to any bank. Your bank does not know this app exists — the message comes from your phone, not from them.',
    'You choose which senders are forwarded, and you can stop at any time.',
    'An arriving message writes nothing. Every draft waits for you to read it; the app never records a transaction on its own.',
    'The secret belongs to your workspace alone. Nobody else’s messages can reach your books, and yours cannot reach theirs.',
  ],
  guides: [ANDROID_EN, IOS_EN],
  reviewHeading: 'What happens when a message arrives',
  review: [
    'The draft comes with the date, the amount and the direction filled in, and the words each was read from are highlighted in the message itself. Anything wrong can be corrected.',
    'Expense, income or transfer — three tabs. A DPS instalment or a card bill is a transfer, so it never lands in income or spending.',
    'Money into a DPS also ticks that month’s instalment, when the amount matches exactly.',
    'A charge in another currency asks what it cost in taka, because the rate your bank used is not published anywhere.',
    'The same message arriving twice adds nothing the second time.',
  ],
  troubleHeading: 'If it does not work',
  trouble: [
    {
      q: 'The answer is 401',
      a: 'The workspace id or the secret is wrong, or name and value are swapped. Copy them from Settings again rather than typing them.',
    },
    {
      q: 'Nothing arrives in the inbox',
      a: 'Check the forwarder actually has that sender selected, and that the battery saver has not stopped the app.',
    },
    {
      q: 'Drafts arrive with no amount',
      a: 'That bank’s message format is not recognised yet. Fill the amount in and add it, then send us feedback with the message — the format gets added.',
    },
    {
      q: 'The inbox fills with OTPs and marketing',
      a: 'Forward only bank and mobile-banking shortcodes, not every sender.',
    },
  ],
  ctaHeading: 'Ready to start?',
  cta: 'Signing up is free and takes no card. The address and secret are waiting in Settings.',
  ctaButton: 'Create a free account',
};
