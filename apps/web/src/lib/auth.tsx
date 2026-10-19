import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { onAuthChange, refreshSession, type AuthUser } from "./api";

interface AuthState {
  user: AuthUser | null;
  ready: boolean;
}

const AuthContext = createContext<AuthState>({ user: null, ready: false });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, ready: false });

  useEffect(() => {
    const off = onAuthChange((user) => setState({ user, ready: true }));
    // Sayfa yenilendiğinde oturumu refresh çereziyle geri yükle
    void refreshSession().then((t) => setState({ user: t?.user ?? null, ready: true }));
    return () => {
      off();
    };
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

export type Role = AuthUser["role"];

const RANK: Record<Role, number> = { viewer: 0, operator: 1, engineer: 2, admin: 3 };

/** ARCHITECTURE.md §8 yetki tablosu */
export function can(user: AuthUser | null, action: "operate" | "configure" | "admin"): boolean {
  if (!user) return false;
  const need = { operate: 1, configure: 2, admin: 3 }[action];
  return RANK[user.role] >= need;
}

export const ROLE_LABEL: Record<Role, string> = {
  admin: "Yönetici",
  engineer: "Mühendis",
  operator: "Operatör",
  viewer: "İzleyici",
};
