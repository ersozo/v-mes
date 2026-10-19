// Socket.io duman testi: geçersiz token reddedilmeli, geçerli token snapshot + canlı olay almalı.
//   INGESTION_URL=http://ingestion:3001 JWT_SECRET=... node scripts/smoke-realtime.mjs
import { SignJWT } from "jose";
import { io } from "socket.io-client";

const url = process.env.INGESTION_URL ?? "http://localhost:3001";
const key = new TextEncoder().encode(process.env.JWT_SECRET);

const sign = (claims, secret = key) =>
  new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setSubject("1").setIssuedAt().setExpirationTime("5m").sign(secret);

function tryConnect(token) {
  return new Promise((resolve) => {
    const s = io(url, { auth: { token }, transports: ["websocket"], reconnection: false, timeout: 5000 });
    s.on("connect", () => resolve({ ok: true, socket: s }));
    s.on("connect_error", (e) => resolve({ ok: false, error: e.message }));
  });
}

let failed = false;
const check = (label, cond) => {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failed = true;
};

const bad1 = await tryConnect(undefined);
check("token olmadan bağlantı reddedilir", !bad1.ok);
const bad2 = await tryConnect(await sign({ type: "access", role: "admin" }, new TextEncoder().encode("x".repeat(40))));
check("yanlış anahtarla imzalı token reddedilir", !bad2.ok);
const bad3 = await tryConnect(await sign({ type: "refresh", role: "admin" }));
check("refresh token ile bağlantı reddedilir", !bad3.ok);

const snapshot = new Promise((r) => {
  globalThis.__snap = r;
});
const good = await new Promise((resolve) => {
  sign({ type: "access", role: "viewer" }).then((token) => {
    const s = io(url, { auth: { token }, transports: ["websocket"], reconnection: false });
    s.on("snapshot", (data) => globalThis.__snap(data));
    s.on("connect", () => resolve({ ok: true, socket: s }));
    s.on("connect_error", (e) => resolve({ ok: false, error: e.message }));
  });
});
check("geçerli viewer token ile bağlanır", good.ok);
if (good.ok) {
  const s = good.socket;
  const snap = await snapshot;
  check(`snapshot gelir (${snap.machines.length} makine, ${snap.edges.length} edge)`, snap.machines.length > 0);
  const ack = await s.emitWithAck("subscribe", { room: "plant" });
  check("plant odasına abone olunur", ack.ok === true);
  const bad = await s.emitWithAck("subscribe", { room: "everything" });
  check("geçersiz oda reddedilir", bad.ok === false);
  const tel = await new Promise((r) => {
    const t = setTimeout(() => r(null), 5000);
    s.once("telemetry", (d) => {
      clearTimeout(t);
      r(d);
    });
  });
  check(`canlı telemetri gelir (${tel?.code}: ${Object.keys(tel?.tags ?? {}).join(", ")})`, tel !== null);
  s.close();
}
process.exit(failed ? 1 : 0);
