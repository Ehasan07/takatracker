'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            /* No retry, and this is not a tuning preference.
             *
             * With `offlineFirst`, a query that fails while the browser is
             * offline does not settle — the retryer *pauses* until the network
             * returns. Any `await queryClient.invalidateQueries()` then hangs
             * forever, which is exactly what quick-add does after parking a
             * transaction: the sheet stayed open over a write that had in fact
             * been saved, and the user pressed the button again.
             *
             * With no retry the query settles as an error, the screen shows its
             * Bengali error state, and the offline bar reports what is queued. */
            retry: 0,
            refetchOnWindowFocus: false,
            // Cached data must still render when the network is gone.
            networkMode: 'offlineFirst',
          },
          mutations: { networkMode: 'offlineFirst' },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
