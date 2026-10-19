import { expect, test } from "@playwright/test";
import { ADMIN, apiToken, login, SIM } from "./helpers";

test.describe("canlı izleme", () => {
  test("canlı panel makineleri ve canlı bağlantıyı gösterir", async ({ page }) => {
    await login(page);
    await expect(page.getByRole("heading", { name: "Canlı panel" })).toBeVisible();
    for (const name of ["CNC Torna 01", "CNC Freze 02", "Eksantrik Pres 01"]) {
      await expect(page.getByText(name, { exact: true })).toBeVisible();
    }
    await expect(page.getByRole("status").filter({ hasText: "Canlı" })).toBeVisible();
  });

  test("simülatörde duruş → kart birkaç saniye içinde 'Duruyor' olur, devam edince 'Çalışıyor'", async ({ page, request }) => {
    await login(page);
    const card = page.getByRole("link").filter({ hasText: "CNC Freze 02" });
    await request.post(`${SIM}/machines/cnc-02/resume`);
    await expect(card.getByText("Çalışıyor")).toBeVisible({ timeout: 20_000 });
    await request.post(`${SIM}/machines/cnc-02/stop?seconds=20`);
    await expect(card.getByText("Duruyor")).toBeVisible({ timeout: 20_000 });
    await request.post(`${SIM}/machines/cnc-02/resume`);
    await expect(card.getByText("Çalışıyor")).toBeVisible({ timeout: 20_000 });
  });

  test("makine detayında canlı tag değerleri güncellenir", async ({ page }) => {
    await login(page);
    await page.getByRole("link").filter({ hasText: "Eksantrik Pres 01" }).click();
    await expect(page.getByRole("heading", { name: "Eksantrik Pres 01" })).toBeVisible();
    const value = page.locator("dt", { hasText: "total_count" }).locator("xpath=following-sibling::dd");
    await expect(value).not.toHaveText("—");
    const first = await value.textContent();
    await expect(value).not.toHaveText(first ?? "", { timeout: 20_000 }); // pres ~2,6 sn'de bir parça
  });
});

test.describe("operatör", () => {
  test("nedeni girilmemiş duruşa neden atanır ve listeden düşer", async ({ page, request }) => {
    const token = await apiToken(request);
    const headers = { Authorization: `Bearer ${token}` };
    const machines = await (await request.get("/api/machines", { headers })).json();
    const downs: { id: number; machine_id: number }[] = await (await request.get("/api/downtimes?unassigned=true&limit=50", { headers })).json();
    test.skip(downs.length === 0, "nedeni girilmemiş duruş yok");
    const target = downs[0]!;
    const machine = machines.find((m: { id: number }) => m.id === target.machine_id);

    await login(page);
    await page.evaluate((id) => localStorage.setItem("vmes:operator-machine", String(id)), machine.id);
    await page.goto("/operator");
    await expect(page.getByText("Nedeni girilmemiş duruşlar")).toBeVisible();
    const before = await page.getByRole("button", { name: "Neden gir" }).count();
    await page.getByRole("button", { name: "Neden gir" }).first().click();
    await page.getByRole("button", { name: "Malzeme bekleme" }).click();
    await page.getByRole("button", { name: "Kaydet" }).click();
    await expect(page.getByRole("button", { name: "Neden gir" })).toHaveCount(before - 1);
  });
});

test.describe("konfigüratör", () => {
  test("geçersiz S7 adresi anında işaretlenir, düzeltince geçerli olur", async ({ page }) => {
    await login(page);
    await page.goto("/configurator");
    await page.getByRole("button", { name: "cnc-01" }).click();
    const address = page.getByLabel("Adres").first();
    await expect(page.getByText("Geçerli")).toBeVisible();
    await address.fill("DB1,INT0"); // toplam sayaç için INT uygun değil
    await expect(page.getByText(/INT tipi uygun değil/)).toBeVisible();
    await expect(page.getByText("Düzeltilmesi gereken alanlar var")).toBeVisible();
    await address.fill("DB1,DINT0");
    await expect(page.getByText("Geçerli")).toBeVisible();
  });

  test("Node-RED dağıtım durumu görünür", async ({ page }) => {
    await login(page);
    await page.goto("/configurator");
    await expect(page.getByText("Node-RED dağıtımı")).toBeVisible();
    await expect(page.getByText(/Node-RED güncel|sekme/)).toBeVisible();
  });
});

test.describe("raporlar", () => {
  test("grafik türü URL'de saklanır, tablo görünümü ve tema çalışır", async ({ page }) => {
    await login(page);
    await page.goto("/reports?preset=today");
    await expect(page.getByRole("heading", { name: "OEE trendi" })).toBeVisible();
    await page.getByRole("radiogroup", { name: "OEE trendi grafik türü" }).getByRole("radio", { name: "Sütun" }).click();
    await expect(page).toHaveURL(/trend\.type=bar/);
    await page.reload();
    await expect(page.getByRole("radiogroup", { name: "OEE trendi grafik türü" }).getByRole("radio", { name: "Sütun" })).toHaveAttribute("aria-checked", "true");

    const production = page.locator("div.rounded-xl", { has: page.getByRole("heading", { name: "Üretim" }) });
    await production.getByRole("button", { name: "Tablo görünümü" }).click();
    await expect(production.getByRole("columnheader", { name: "Dönem" })).toBeVisible();

    await page.getByRole("button", { name: /Tema:/ }).click(); // sistem → açık
    await page.getByRole("button", { name: /Tema:/ }).click(); // açık → koyu
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("button", { name: /Tema:/ }).click(); // koyu → sistem
  });
});

test.describe("yetkiler", () => {
  test("izleyici yalnızca izleme ekranlarını görür; korumalı sayfalar yönlendirilir", async ({ page, request }) => {
    const token = await apiToken(request);
    const headers = { Authorization: `Bearer ${token}` };
    const username = `e2e-viewer-${Date.now()}`;
    const created = await request.post("/api/users", { headers, data: { username, role: "viewer", password: "E2eViewer123" } });
    expect(created.ok()).toBeTruthy();
    const { id } = await created.json();
    try {
      await login(page, { username, password: "E2eViewer123" });
      const nav = page.getByRole("navigation", { name: "Ana menü" });
      await expect(nav.getByRole("link", { name: "Raporlar" })).toBeVisible();
      for (const hidden of ["Operatör ekranı", "PLC konfigüratörü", "Tanımlar", "Kullanıcılar"]) {
        await expect(nav.getByRole("link", { name: hidden })).toHaveCount(0);
      }
      await page.goto("/configurator");
      await expect(page).toHaveURL(/\/$/);
    } finally {
      await request.patch(`/api/users/${id}`, { headers, data: { is_active: false } });
    }
  });

  test("çıkış sonrası korumalı sayfa giriş ekranına yönlendirir", async ({ page }) => {
    await login(page, ADMIN);
    await page.getByRole("button", { name: "Çıkış" }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/reports");
    await expect(page).toHaveURL(/\/login/);
  });
});
