'use client';

import { createContext, type ReactNode, useContext } from 'react';
import type { Me } from '@/lib/core';

const CurrentUserContext = createContext<Me | null>(null);

export function CurrentUserProvider({ user, children }: { user: Me; children: ReactNode }) {
  return <CurrentUserContext.Provider value={user}>{children}</CurrentUserContext.Provider>;
}

/** The logged-in user, with roles and capabilities. Only inside the admin shell. */
export function useCurrentUser(): Me {
  const user = useContext(CurrentUserContext);
  if (!user) throw new Error('useCurrentUser must be used inside the admin shell.');
  return user;
}

export function useCan(capability: string): boolean {
  return Boolean(useCurrentUser().capabilities[capability]);
}
