import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuthProvider } from "./lib/auth";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: (count, err) => count < 2 && !(err instanceof Error && "status" in err && [401, 403, 404, 422].includes((err as { status: number }).status)),
      refetchOnWindowFocus: false,
      // Tazelenirken önceki veriyi tut (iskelet yanıp sönmesi yok)
      placeholderData: (prev: unknown) => prev,
    },
  },
  queryCache: new QueryCache(),
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
