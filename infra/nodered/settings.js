// Node-RED ayarları — MES. Tüm gizli bilgiler ortam değişkenlerinden gelir.
const crypto = require("crypto");

const ADMIN_USER = process.env.NODERED_ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.NODERED_ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  throw new Error("NODERED_ADMIN_PASSWORD tanımlı değil");
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const adminUser = { username: ADMIN_USER, permissions: "*" };

module.exports = {
  uiPort: 1880,
  flowFile: "flows.json",
  flowFilePretty: true,
  credentialSecret: process.env.NODERED_CREDENTIAL_SECRET,

  // Editör ve Admin API kimlik doğrulaması. MES API servisi de bu hesapla
  // POST /auth/token üzerinden token alır.
  adminAuth: {
    type: "credentials",
    sessionExpiryTime: 8 * 60 * 60,
    users: async (username) => (username === ADMIN_USER ? adminUser : null),
    authenticate: async (username, password) =>
      username === ADMIN_USER && safeEqual(password, ADMIN_PASSWORD) ? adminUser : null,
  },

  diagnostics: { enabled: false },
  telemetry: { enabled: false },
  externalModules: {
    // Palette'ten modül kurulumu kapalı: düğümler yalnızca imajla gelir.
    palette: { allowInstall: false },
    modules: { allowInstall: false },
  },

  logging: {
    console: { level: "info", metrics: false, audit: false },
  },

  editorTheme: {
    projects: { enabled: false },
    tours: false,
    header: { title: "V-MES Edge" },
  },
};
