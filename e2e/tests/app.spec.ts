import { expect, test } from "@playwright/test";
import { ADMIN, apiToken, login, loginViaForm, SIM } from "./helpers";

test.describe("canlı izleme", () => {
  test("giriş formu → canlı panel makineleri ve canlı bağlantıyı gösterir", async ({ page }) => {
    await loginViaForm(page);
    await expect(page.getByRole("heading", { name: "Canlı panel" })).toBeVisible();
    for (const name of ["CNC Torna 01", "CNC Freze 02", "Eksantrik Pres 01", "Gövde Montaj 01"]) {
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

  test("makine detayında canlı tag değerleri güncellenir", async ({ page, request }) => {
    // Simülatörün rastgele duruşuna denk gelmemek için makineyi çalışır duruma al
    await request.post(`${SIM}/machines/pres-01/resume`);
    await login(page);
    await page.getByRole("link").filter({ hasText: "Eksantrik Pres 01" }).click();
    await expect(page.getByRole("heading", { name: "Eksantrik Pres 01" })).toBeVisible();
    const value = page.locator("dt", { hasText: "total_count" }).locator("xpath=following-sibling::dd");
    await expect(value).not.toHaveText("—");
    const first = await value.textContent();
    await expect(value).not.toHaveText(first ?? "", { timeout: 20_000 }); // pres ~2,6 sn'de bir parça
  });

  test("seri istasyonlu makinede İstasyonlar kartı ve görünümleri", async ({ page }) => {
    await login(page);
    await page.getByRole("link").filter({ hasText: "Gövde Montaj 01" }).click();
    await expect(page.getByRole("heading", { name: "İstasyonlar" })).toBeVisible();
    await page.getByRole("radio", { name: "Son 24 saat" }).click();
    await expect(page.getByText("5. istasyon").first()).toBeVisible({ timeout: 20_000 });
    await page.getByRole("radio", { name: "Tablo" }).last().click();
    await expect(page.getByRole("cell", { name: "ist3_kosu" })).toBeVisible();
    // İstasyon bitleri tek tek telemetri grafiği olarak gösterilmez
    await expect(page.getByRole("heading", { name: "ist1_kosu" })).toHaveCount(0);
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
    await expect(page.getByText(/\d+ edge · (hepsi güncel|\d+ edge'de değişiklik var)/)).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "edge-01" })).toBeVisible();
  });
});

test.describe("edge ve içe aktarma", () => {
  test("Edge cihazları sayfası edge'i, makinelerini ve kontrol sonucunu gösterir", async ({ page }) => {
    await login(page);
    await page.goto("/edges");
    const row = page.getByRole("row").filter({ hasText: "edge-01" });
    await expect(row).toContainText("cnc-01");
    await expect(row.getByText("Çevrimiçi")).toBeVisible({ timeout: 20_000 });
    await row.getByRole("button", { name: "Kontrol" }).click();
    await expect(page.getByText("node-red-contrib-s7 3.")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Uyumlu — dağıtıma hazır.")).toBeVisible();
  });

  test("TIA satırları yapıştırılıp rol atanarak tag listesine aktarılır", async ({ page }) => {
    await login(page);
    await page.goto("/configurator");
    await page.getByRole("button", { name: "cnc-02" }).click();
    await page.getByRole("button", { name: "TIA'dan içe aktar" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: "DB editöründen yapıştır" }).click();
    await dialog.getByLabel("DB numarası").fill("200");
    await dialog.locator("textarea").fill("MakinaIstasyonData[7]\tStruct\t952.0\nkosuBiti\tBool\t952.2\nsonsuzSayici\tUInt\t956.0");
    await dialog.getByRole("button", { name: "Satırları oku" }).click();
    await expect(dialog.getByText("DB200,WORD956")).toBeVisible();
    await expect(dialog.getByText("sayaç adayı")).toBeVisible();
    await dialog.getByRole("row").filter({ hasText: "DB200,WORD956" }).getByLabel("Rol").selectOption("process");
    await dialog.getByRole("row").filter({ hasText: "DB200,WORD956" }).getByLabel("sonsuzSayici seç", { exact: false }).check();
    await dialog.getByRole("button", { name: /tag'i aktar/ }).click();
    // Tag tabloya eklendi (kaydetmeden; sayfadan ayrılınca kaybolur)
    await expect(page.getByLabel("Adres").last()).toHaveValue("DB200,WORD956");
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
    await loginViaForm(page, ADMIN);
    await page.getByRole("button", { name: "Çıkış" }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/reports");
    await expect(page).toHaveURL(/\/login/);
  });
});
