import { AppShell } from '@/components/app-shell';
import { LocaleSync } from '@/components/locale-sync';

export default function ShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Renders nothing. It puts the workspace's language where the number and
          date formatters can read it — see `lib/format.ts`. Here rather than in
          the root layout because the marketing pages have no workspace, and a
          signed-out visitor must not have `/auth/me` fetched on their behalf. */}
      <LocaleSync />
      <AppShell>{children}</AppShell>
    </>
  );
}
