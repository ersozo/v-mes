import { expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";

export const ADMIN = { username: process.env.ADMIN_USERNAME ?? "admin", password: process.env.ADMIN_PASSWORD ?? "" };
export const SIM = process.env.SIMULATOR_URL ?? "http://simulator:8090";
/** API'ye doğrudan (nginx'i atlayarak): giriş hız sınırına takılmadan her teste ayrı oturum. */
const API = process.env.API_URL ?? "http://api:8000";
const WEB_HOST = new URL(process.env.BASE_URL ?? "http://web:8080").hostname;

/** Giriş formunu kullanarak giriş (formun kendisini test etmek için). */
export async function loginViaForm(page: Page, user = ADMIN) {
  await page.goto("/login");
  await page.getByLabel("Kullanıcı adı").fill(user.username);
  await page.getByLabel("Şifre").fill(user.password);
  await page.getByRole("button", { name: "Giriş yap" }).click();
  await expect(page).toHaveURL(/\/$/);
}

/**
 * Hızlı giriş: API'den yeni bir refresh çerezi alıp tarayıcıya verir; uygulama açılışta oturumu bununla yükler.
 * (Kayıtlı tek oturumu paylaşmak işe yaramaz: refresh token her kullanımda yenilenir ve eskisinin tekrar
 * kullanımı "çalınmış token" sayılıp tüm oturumları kapatır.)
 */
export async function login(page: Page, user = ADMIN) {
  const ctx = await pwRequest.newContext();
  const res = await ctx.post(`${API}/api/auth/login`, { data: user });
  expect(res.ok(), `giriş başarısız: ${res.status()}`).toBeTruthy();
  const cookie = (await ctx.storageState()).cookies.find((c) => c.name === "vmes_refresh");
  await ctx.dispose();
  expect(cookie).toBeTruthy();
  await page.context().addCookies([{ name: "vmes_refresh", value: cookie!.value, domain: WEB_HOST, path: "/api/auth", httpOnly: true, sameSite: "Strict" }]);
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Ana menü" })).toBeVisible();
}

export async function apiToken(request: APIRequestContext, user = ADMIN): Promise<string> {
  const r = await request.post(`${API}/api/auth/login`, { data: user });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).access_token as string;
}
