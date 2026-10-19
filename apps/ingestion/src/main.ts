import { createServer } from "node:http";
import { SUBSCRIPTIONS } from "@vmes/contracts";
import mqtt from "mqtt";
import { loadConfig } from "./config.js";
import { Ingestor } from "./ingestor.js";
import { logger } from "./logger.js";
import { Realtime } from "./realtime.js";
import { Store } from "./store.js";

async function connectStore(cfg: ReturnType<typeof loadConfig>): Promise<Store> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await Store.connect(cfg);
    } catch (err) {
      const wait = Math.min(15_000, 1000 * attempt);
      logger.warn({ err: String(err), attempt, wait }, "veritabanına bağlanılamadı; tekrar denenecek");
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = await connectStore(cfg);
  const ingestor = await Ingestor.create(cfg, store, logger);
  logger.info("makine kaydı ve kalıcı durum yüklendi");

  let mqttConnected = false;
  let dbHealthy = true;

  const http = createServer((req, res) => {
    if (req.url === "/health") {
      const ok = mqttConnected && dbHealthy && !ingestor.getStats().lastFlushError;
      res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: ok ? "ok" : "degraded", mqtt: mqttConnected, db: dbHealthy, ...ingestor.getStats() }));
      return;
    }
    res.writeHead(404).end();
  });
  const realtime = new Realtime(http, cfg.JWT_SECRET, cfg.CORS_ORIGIN, () => ingestor.snapshot(), logger);
  ingestor.attachRealtime(realtime);
  await new Promise<void>((resolve) => http.listen(cfg.HTTP_PORT, resolve));
  logger.info({ port: cfg.HTTP_PORT }, "HTTP / Socket.io dinleniyor");

  const client = mqtt.connect(cfg.MQTT_URL, {
    clientId: cfg.MQTT_CLIENT_ID,
    username: cfg.MQTT_USER,
    password: cfg.MQTT_PASSWORD,
    // Kalıcı oturum: kısa kesintilerde QoS 1 mesajları broker'da bekler.
    clean: false,
    reconnectPeriod: 2000,
    connectTimeout: 10_000,
  });
  client.on("connect", () => {
    mqttConnected = true;
    logger.info("MQTT bağlandı");
    client.subscribe(Object.values(SUBSCRIPTIONS).map((t) => t), { qos: 1 }, (err) => {
      if (err) logger.error({ err }, "MQTT abonelik hatası");
    });
  });
  client.on("close", () => {
    if (mqttConnected) logger.warn("MQTT bağlantısı koptu");
    mqttConnected = false;
  });
  client.on("error", (err) => logger.error({ err: err.message }, "MQTT hatası"));
  client.on("message", (topic, payload) => {
    try {
      ingestor.handleMessage(topic, payload);
    } catch (err) {
      logger.error({ err, topic }, "mesaj işlenirken beklenmeyen hata");
    }
  });

  const timers = [
    setInterval(() => void ingestor.flush(), cfg.FLUSH_INTERVAL_MS),
    setInterval(() => ingestor.tick(), 1000),
    setInterval(() => {
      ingestor.refreshRegistry().catch((err) => logger.error({ err: String(err) }, "makine kaydı yenilenemedi"));
    }, cfg.REGISTRY_REFRESH_MS),
    setInterval(async () => {
      dbHealthy = await store.ping();
    }, 10_000),
  ];

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "kapanıyor");
    timers.forEach(clearInterval);
    await new Promise<void>((r) => client.end(false, {}, () => r()));
    await ingestor.drain();
    await realtime.close();
    await store.close();
    logger.info("kapandı");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err }, "başlatılamadı");
  process.exit(1);
});
