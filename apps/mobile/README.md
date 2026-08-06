# @hishab/mobile — Expo (iOS + Android)

Reserved workspace. The Expo app is **M15** in the build plan; nothing is
installed here yet so the monorepo install stays fast during M0–M4.

When M15 starts:

```bash
pnpm dlx create-expo-app@latest . --template expo-template-blank-typescript
pnpm add expo-router expo-sqlite expo-secure-store @tanstack/react-query \
         @hishab/shared @hishab/core @hishab/parsers @hishab/ui
```

Constraints already fixed by the spec:

- `expo-sqlite` for the local database, encrypted (SQLCipher or equivalent).
- Android SMS listener is **M19** and must be compile-time excluded on iOS —
  not stubbed, not merely hidden (App Store rejects the capability outright).
- `packages/core` and `packages/parsers` have zero framework imports, so the
  ledger engine and the message parser run here unchanged.
