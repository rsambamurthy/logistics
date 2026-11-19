import { createContext, useContext } from 'react';

// Signed-in user, tenant and subscription access state.
export const SessionCtx = createContext({});
export const useSession = () => useContext(SessionCtx);

/** can('jobs.manage') — what the signed-in user's role allows (the server checks again on every request). */
export function useCan() {
  const perms = useContext(SessionCtx)?.user?.perms || [];
  return (code) => perms.includes(code);
}
