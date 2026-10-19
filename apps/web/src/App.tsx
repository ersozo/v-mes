import { useQuery } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { createBrowserRouter, Navigate, RouterProvider, useLocation } from "react-router";
import { Layout } from "./components/Layout";
import { Spinner } from "./components/ui";
import { api } from "./lib/api";
import { can, useAuth } from "./lib/auth";
import { setPlantTimezone } from "./lib/format";
import type { PlantSettings } from "./lib/types";
import { ConfiguratorPage } from "./pages/Configurator";
import { DefinitionsPage } from "./pages/Definitions";
import { LiveDashboard } from "./pages/LiveDashboard";
import { LoginPage } from "./pages/Login";
import { MachineDetailPage } from "./pages/MachineDetail";
import { OperatorPage } from "./pages/Operator";
import { OrdersPage } from "./pages/Orders";
import { ReportsPage } from "./pages/Reports";
import { UsersPage } from "./pages/Users";

function RequireAuth({ children, need }: { children: ReactNode; need?: "operate" | "configure" | "admin" }) {
  const { user, ready } = useAuth();
  const location = useLocation();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<PlantSettings>("/api/settings"), enabled: !!user, staleTime: 300_000 });
  useEffect(() => {
    if (settings.data) setPlantTimezone(settings.data.timezone);
  }, [settings.data]);

  if (!ready) return <Spinner />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (need && !can(user, need)) return <Navigate to="/" replace />;
  if (!settings.data && settings.isLoading) return <Spinner />;
  return <>{children}</>;
}

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    element: (
      <RequireAuth>
        <Layout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <LiveDashboard /> },
      { path: "machines/:id", element: <MachineDetailPage /> },
      { path: "reports", element: <ReportsPage /> },
      { path: "orders", element: <OrdersPage /> },
      { path: "operator", element: <RequireAuth need="operate"><OperatorPage /></RequireAuth> },
      { path: "configurator", element: <RequireAuth need="configure"><ConfiguratorPage /></RequireAuth> },
      { path: "definitions", element: <RequireAuth need="configure"><DefinitionsPage /></RequireAuth> },
      { path: "users", element: <RequireAuth need="admin"><UsersPage /></RequireAuth> },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
