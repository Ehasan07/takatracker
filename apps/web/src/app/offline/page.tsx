import Link from 'next/link';

export const metadata = { title: 'অফলাইন — হিসাব' };

export default function OfflinePage() {
  return (
    <main className="app-scroll safe-x mx-auto flex h-dvh max-w-md flex-col items-center justify-center gap-4 text-center [--gutter-x:1rem]">
      <h1 className="text-ink text-2xl font-extrabold">এখন অফলাইন</h1>
      <p className="text-ink-muted">
        ইন্টারনেট সংযোগ নেই। আগে দেখা পাতাগুলো এখনও খোলা যাবে, আর নতুন লেনদেন সংরক্ষিত থাকবে — সংযোগ
        ফিরলে নিজে থেকেই পাঠানো হবে।
      </p>
      <Link
        href="/"
        className="bg-income flex min-h-11 items-center rounded-xl px-4 text-sm font-medium text-white"
      >
        আবার চেষ্টা করুন
      </Link>
    </main>
  );
}
