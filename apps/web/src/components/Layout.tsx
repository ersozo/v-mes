import { BarChart3, ClipboardList, Cpu, Factory, LogOut, Monitor, Moon, Settings2, Sun, SunMoon, Tablet, Users } from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { logout } from "../lib/api";
import { can, ROLE_LABEL, useAuth } from "../lib/auth";
import { useLive } from "../lib/live";
import { useTheme, type ThemePref } from "../lib/theme";
import { cn } from "./ui";

const NAV = [
  { to: "/", label: "Canlı panel", icon: Monitor, need: null },
  { to: "/reports", label: "Raporlar", icon: BarChart3, need: null },
  { to: "/orders", label: "İş emirleri", icon: ClipboardList, need: null },
  { to: "/operator", label: "Operatör ekranı", icon: Tablet, need: "operate" },
  { to: "/configurator", label: "PLC konfigüratörü", icon: Cpu, need: "configure" },
  { to: "/definitions", label: "Tanımlar", icon: Settings2, need: "configure" },
  { to: "/users", label: "Kullanıcılar", icon: Users, need: "admin" },
] as const;

const THEME_NEXT: Record<ThemePref, ThemePref> = { system: "light", light: "dark", dark: "system" };
const THEME_ICON = { system: SunMoon, light: Sun, dark: Moon };
const THEME_LABEL = { system: "Tema: sistem", light: "Tema: açık", dark: "Tema: koyu" };

function ConnectionStatus() {
  const connected = useLive((s) => s.connected);
  const edges = useLive((s) => Object.entries(s.edges));
  const offlineEdges = edges.filter(([, online]) => !online).map(([id]) => id);
  const ok = connected && offlineEdges.length === 0;
  const text = !connected ? "Canlı bağlantı yok" : offlineEdges.length ? `Edge erişilemiyor: ${offlineEdges.join(", ")}` : "Canlı";
  return (
    <div className="flex items-center gap-2 px-3 text-[12px] text-ink-2" role="status" title={text}>
      <span className={cn("size-2 rounded-full", ok ? "bg-good" : "bg-critical", ok && "animate-pulse")} aria-hidden />
      <span className="truncate">{text}</span>
    </div>
  );
}

export function Layout() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [theme, setTheme] = useTheme();
  const [open, setOpen] = useState(false);
  const ThemeIcon = THEME_ICON[theme];

  return (
    <div className="flex min-h-full">
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-30 flex w-60 flex-col border-r border-line bg-surface transition-transform md:sticky md:top-0 md:h-screen md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-14 items-center gap-2 px-4 font-semibold">
          <Factory className="size-5 text-accent" aria-hidden />
          V-MES
        </div>
        <nav className="flex-1 space-y-0.5 px-2 py-2" aria-label="Ana menü">
          {NAV.filter((n) => !n.need || can(user, n.need)).map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/"}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                cn(
                  "flex h-9 items-center gap-3 rounded-lg px-3 text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink",
                  isActive && "bg-surface-2 font-medium text-ink",
                )
              }
            >
              <n.icon className="size-4" aria-hidden />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <ConnectionStatus />
        <div className="m-2 flex items-center gap-2 rounded-lg border border-line p-2">
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{user?.display_name || user?.username}</div>
            <div className="truncate text-[12px] text-muted">{user && `${user.username} · ${ROLE_LABEL[user.role]}`}</div>
          </div>
          <button className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-ink" onClick={() => setTheme(THEME_NEXT[theme])} title={THEME_LABEL[theme]} aria-label={THEME_LABEL[theme]}>
            <ThemeIcon className="size-4" />
          </button>
          <button
            className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-ink"
            onClick={async () => {
              await logout();
              navigate("/login");
            }}
            title="Çıkış"
            aria-label="Çıkış"
          >
            <LogOut className="size-4" />
          </button>
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-20 bg-black/30 md:hidden" onClick={() => setOpen(false)} />}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b border-line bg-surface px-4 md:hidden">
          <button className="rounded-md p-1.5 hover:bg-surface-2" onClick={() => setOpen(true)} aria-label="Menüyü aç">
            <Factory className="size-5 text-accent" />
          </button>
          <span className="font-semibold">V-MES</span>
        </header>
        <main className="min-w-0 flex-1 px-4 py-5 md:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
