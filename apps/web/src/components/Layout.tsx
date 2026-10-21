import { BarChart3, ClipboardList, Cpu, Factory, LogOut, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Router, Settings2, Sun, SunMoon, Tablet, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router";
import { logout } from "../lib/api";
import { can, ROLE_LABEL, useAuth } from "../lib/auth";
import { useLive } from "../lib/live";
import { useTheme, type ThemePref } from "../lib/theme";
import { readPref, writePref } from "../lib/url-state";
import { cn } from "./ui";

const NAV = [
  { to: "/", label: "Canlı panel", icon: Monitor, need: null },
  { to: "/reports", label: "Raporlar", icon: BarChart3, need: null },
  { to: "/orders", label: "İş emirleri", icon: ClipboardList, need: null },
  { to: "/operator", label: "Operatör ekranı", icon: Tablet, need: "operate" },
  { to: "/configurator", label: "PLC konfigüratörü", icon: Cpu, need: "configure" },
  { to: "/edges", label: "Edge cihazları", icon: Router, need: "configure" },
  { to: "/definitions", label: "Tanımlar", icon: Settings2, need: "configure" },
  { to: "/users", label: "Kullanıcılar", icon: Users, need: "admin" },
] as const;

const THEME_NEXT: Record<ThemePref, ThemePref> = { system: "light", light: "dark", dark: "system" };
const THEME_ICON = { system: SunMoon, light: Sun, dark: Moon };
const THEME_LABEL = { system: "Tema: sistem", light: "Tema: açık", dark: "Tema: koyu" };

function ConnectionStatus({ collapsed }: { collapsed: boolean }) {
  const connected = useLive((s) => s.connected);
  const edges = useLive((s) => Object.entries(s.edges));
  const skews = useLive((s) => Object.entries(s.edgeSkew));
  const offlineEdges = edges.filter(([, online]) => !online).map(([id]) => id);
  const skewed = skews.filter(([, v]) => v !== null && Math.abs(v) > 30);
  const ok = connected && offlineEdges.length === 0 && skewed.length === 0;
  const text = !connected
    ? "Canlı bağlantı yok"
    : offlineEdges.length
      ? `Edge erişilemiyor: ${offlineEdges.join(", ")}`
      : skewed.length
        ? `Edge saati kaymış: ${skewed.map(([id, v]) => `${id} ${v! > 0 ? "−" : "+"}${Math.abs(v!)} sn`).join(", ")} (NTP)`
        : "Canlı";
  return (
    <div className={cn("flex items-center gap-2 px-3 text-[12px] text-ink-2", collapsed && "md:justify-center md:px-0")} role="status" title={text}>
      <span className={cn("size-2 shrink-0 rounded-full", ok ? "bg-good" : "bg-critical", ok && "animate-pulse")} aria-hidden />
      <span className={cn("truncate", collapsed && "md:sr-only")}>{text}</span>
    </div>
  );
}

/** Masaüstünde yan panel ikon şeridine daraltılabilir (tercih saklanır; "[" kısayolu). Mobilde açılır menü olarak kalır. */
function useSidebarCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => readPref("sidebar") === "collapsed");
  const toggle = () =>
    setCollapsed((c) => {
      writePref("sidebar", c ? "expanded" : "collapsed");
      return !c;
    });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "[" || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return;
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return [collapsed, toggle];
}

export function Layout() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [theme, setTheme] = useTheme();
  const [open, setOpen] = useState(false);
  const [collapsed, toggleCollapsed] = useSidebarCollapsed();
  const ThemeIcon = THEME_ICON[theme];
  const name = user?.display_name || user?.username || "";
  // Daraltılmış hâl yalnızca masaüstünde (md+) geçerli; "md:" önekli sınıflarla
  const narrow = (cls: string) => collapsed && cls;

  return (
    <div className="flex min-h-full">
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-30 flex w-60 flex-col border-r border-line bg-surface transition-[transform,width] md:sticky md:top-0 md:h-screen md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
          narrow("md:w-14"),
        )}
      >
        <div className={cn("flex h-14 items-center gap-2 px-4 font-semibold", narrow("md:justify-center md:px-0"))}>
          <Factory className={cn("size-5 text-accent", narrow("md:hidden"))} aria-hidden />
          <span className={cn("flex-1", narrow("md:hidden"))}>V-MES</span>
          <button
            className="hidden rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-ink md:block"
            onClick={toggleCollapsed}
            title={collapsed ? "Menüyü genişlet ( [ )" : "Menüyü daralt ( [ )"}
            aria-label={collapsed ? "Menüyü genişlet" : "Menüyü daralt"}
            aria-expanded={!collapsed}
          >
            {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          </button>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-2" aria-label="Ana menü">
          {NAV.filter((n) => !n.need || can(user, n.need)).map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/"}
              onClick={() => setOpen(false)}
              title={collapsed ? n.label : undefined}
              className={({ isActive }) =>
                cn(
                  "flex h-9 items-center gap-3 rounded-lg px-3 text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink",
                  isActive && "bg-surface-2 font-medium text-ink",
                  narrow("md:justify-center md:px-0"),
                )
              }
            >
              <n.icon className="size-4 shrink-0" aria-hidden />
              <span className={cn("truncate", narrow("md:sr-only"))}>{n.label}</span>
            </NavLink>
          ))}
        </nav>
        <ConnectionStatus collapsed={collapsed} />
        <div className={cn("m-2 flex items-center gap-2 rounded-lg border border-line p-2", narrow("md:flex-col md:gap-1 md:p-1"))}>
          <div className={cn("min-w-0 flex-1", narrow("md:hidden"))}>
            <div className="truncate font-medium">{name}</div>
            <div className="truncate text-[12px] text-muted">{user && `${user.username} · ${ROLE_LABEL[user.role]}`}</div>
          </div>
          {collapsed && (
            <div className="hidden size-7 items-center justify-center rounded-full bg-surface-2 text-[12px] font-medium md:flex" title={user ? `${name} · ${ROLE_LABEL[user.role]}` : undefined} aria-hidden>
              {name.slice(0, 1).toLocaleUpperCase("tr")}
            </div>
          )}
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
