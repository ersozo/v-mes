// API istemcisi: access token bellekte tutulur; 401'de refresh çereziyle bir kez yenilenip istek tekrarlanır.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export interface AuthUser {
  id: number;
  username: string;
  display_name: string | null;
  role: "admin" | "engineer" | "operator" | "viewer";
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  user: AuthUser;
}

let accessToken: string | null = null;
let refreshing: Promise<TokenResponse | null> | null = null;
const listeners = new Set<(user: AuthUser | null, token: string | null) => void>();

export function onAuthChange(fn: (user: AuthUser | null, token: string | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setSession(t: TokenResponse | null): void {
  accessToken = t?.access_token ?? null;
  listeners.forEach((fn) => fn(t?.user ?? null, accessToken));
}

export function getAccessToken(): string | null {
  return accessToken;
}

async function parseError(res: Response): Promise<ApiError> {
  let body: unknown;
  let message = `İstek başarısız (HTTP ${res.status})`;
  try {
    body = await res.json();
    const detail = (body as { detail?: unknown }).detail;
    if (typeof detail === "string") message = detail;
    else if (Array.isArray(detail)) {
      message = detail
        .map((d: { loc?: unknown[]; msg?: string }) => {
          const field = (d.loc ?? []).filter((x) => x !== "body").join(".");
          return `${field ? field + ": " : ""}${(d.msg ?? "").replace(/^Value error, /, "")}`;
        })
        .join("\n");
    }
  } catch {
    /* gövde JSON değil */
  }
  return new ApiError(res.status, message, body);
}

/** Refresh çereziyle yeni access token alır; aynı anda gelen çağrılar tek isteği paylaşır. */
export function refreshSession(): Promise<TokenResponse | null> {
  refreshing ??= fetch("/api/auth/refresh", { method: "POST", credentials: "same-origin" })
    .then(async (res) => {
      const t = res.ok ? ((await res.json()) as TokenResponse) : null;
      setSession(t);
      return t;
    })
    .catch(() => {
      setSession(null);
      return null;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw await parseError(res);
  const t = (await res.json()) as TokenResponse;
  setSession(t);
  return t.user;
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
  setSession(null);
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const doFetch = () =>
    fetch(path, {
      ...rest,
      credentials: "same-origin",
      headers: {
        ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...rest.headers,
      },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });

  let res = await doFetch();
  if (res.status === 401 && !path.startsWith("/api/auth/")) {
    if (await refreshSession()) res = await doFetch();
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** CSV gibi dosya yanıtlarını indirir (Authorization başlığıyla). */
export async function download(path: string, filename: string): Promise<void> {
  let res = await fetch(path, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {} });
  if (res.status === 401 && (await refreshSession())) {
    res = await fetch(path, { headers: { Authorization: `Bearer ${accessToken}` } });
  }
  if (!res.ok) throw await parseError(res);
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}
