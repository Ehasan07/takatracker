'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, endpoints, type MeDto } from '@/lib/api';

/**
 * `/auth/me` returns `onboardingCompletedAt` next to everything `MeDto`
 * declares — see `AuthController.me`, which merges it in as an additive field.
 *
 * Intersected in here rather than added to `MeDto`, the same way
 * `quick-add-sheet.tsx` intersects `tags`: `@/lib/api` belongs to another
 * change, and first run is the only thing that reads this field.
 */
export type MeWithOnboarding = MeDto & { onboardingCompletedAt: string | null };

/** What `POST /auth/onboarding/complete` answers. Idempotent — see below. */
export interface OnboardingReceipt {
  completed: true;
  completedAt: string;
  alreadyCompleted: boolean;
}

/**
 * The shared `['me']` cache, read for the one extra field.
 *
 * `queryFn` stays `endpoints.me` so this hook and the four other readers of
 * that key — the shell's greeting, the offline bar, the operator flag, the
 * settings page — remain one request and one cache entry. Only the type
 * widens, and it widens to what the endpoint has always sent.
 */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: endpoints.me,
    select: (data: MeDto) => data as MeWithOnboarding,
  });
}

/**
 * Mark first run done, whether they finished it or walked away from it.
 *
 * The server stores this as an append-only audit event and returns the original
 * timestamp on every later call, so pressing it twice — the skip button and
 * then the dashboard card, say — is harmless.
 *
 * Deliberately not `queueWhenOffline`. Parking it would make the button appear
 * to work while `/auth/me` went on saying null, so the card would come back on
 * the next screen and the person would have been lied to. Offline, the caller
 * shows what went wrong and still lets them leave.
 */
export function useCompleteOnboarding() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<OnboardingReceipt>('/auth/onboarding/complete', { method: 'POST', body: {} }),
    onSuccess: () => {
      // The dashboard card and this route both key off `me`, nothing else does.
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });
}
