import { createContext, useContext } from 'react';

// Signed-in user, tenant and subscription access state.
export const SessionCtx = createContext({});
export const useSession = () => useContext(SessionCtx);
