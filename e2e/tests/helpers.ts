import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const ADMIN = { username: process.env.ADMIN_USERNAME ?? "admin", password: process.env.ADMIN_PASSWORD ?? "" };
export const SIM = process.env.SIMULATOR_URL ?? "http://simulator:8090";

export async function login(page: Page, user = ADMIN) {
  await page.goto("/login");
  await page.getByLabel("Kullanıcı adı").fill(user.username);
  await page.getByLabel("Şifre").fill(user.password);
  await page.getByRole("button", { name: "Giriş yap" }).click();
  await expect(page).toHaveURL(/\/$/);
}

export async function apiToken(request: APIRequestContext, user = ADMIN): Promise<string> {
  const r = await request.post("/api/auth/login", { data: user });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).access_token as string;
}
