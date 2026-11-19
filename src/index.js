import http from "node:http";
import { getActiveModel } from "./ai.js";
import { loadConfig } from "./config.js";
import { getDb } from "./db.js";
import { startWhatsAppBot } from "./whatsapp.js";

function startHealthServer(config, db, getBotStatus) {
  if (!config.healthPort || config.healthPort <= 0) {
    return null;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/health" || url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          bot: config.botName,
          model: getActiveModel(config.geminiModel),
          db: db.engine,
          uptimeSec: Math.floor(process.uptime()),
          whatsapp: getBotStatus(),
        })
      );
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(config.healthPort, config.healthHost, () => {
    console.log(
      `🩺 [Health] Endpoint aktif di http://${config.healthHost}:${config.healthPort}/health`
    );
  });

  return server;
}

async function main() {
  const config = loadConfig();
  const isPairMode = process.argv.includes("--pair");

  if (!config.geminiApiKey || config.geminiApiKey === "your_gemini_api_key_here") {
    console.error("❌ GEMINI_API_KEY belum dikonfigurasi.");
    console.error("   Salin .env.example menjadi .env lalu isi GEMINI_API_KEY Anda.");
    process.exit(1);
  }

  console.log(`🚀 Memulai ${config.botName} WhatsApp Bot...`);
  console.log(
    `⚙️  Model: ${config.geminiModel} | Mode Grup: ${config.groupMode} | Auth Dir: ${config.authDir}`
  );

  const db = await getDb(config);
  console.log(`🗄️  Database aktif: ${db.engine}`);

  let botController = null;
  let healthServer = null;

  botController = await startWhatsAppBot({
    config,
    db,
    forcePairNotice: isPairMode,
  });

  healthServer = startHealthServer(config, db, () =>
    botController ? botController.getStatus() : { connectionState: "starting" }
  );

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n🛑 Menerima sinyal ${signal}, menutup ${config.botName} WhatsApp Bot...`);
    try {
      if (healthServer) {
        await new Promise((resolve) => healthServer.close(resolve));
      }
      if (botController) {
        await botController.stop();
      }
      if (db && typeof db.close === "function") {
        await db.close();
      }
    } catch (err) {
      console.error("[Shutdown] Error:", err?.message || err);
    } finally {
      process.exit(0);
    }
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

process.on("unhandledRejection", (reason) => {
  console.error("[UnhandledRejection]", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[UncaughtException]", err);
});

main().catch((err) => {
  console.error("❌ Gagal memulai WhatsApp Bot:", err?.message || err);
  process.exit(1);
});
