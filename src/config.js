import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizePhoneNumber } from "./utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BOT_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(BOT_ROOT, "..");

let envLoaded = false;

function parseAndInjectEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("export ")) {
      trimmed = trimmed.slice(7).trim();
    }

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    if (!key) continue;

    let val = trimmed.slice(eqIdx + 1).trim();
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

/**
 * Memuat environment variable dari folder whatsapp-bot (.env.local / .env) lebih dulu,
 * lalu fallback ke root project (../.env.local / ../.env) untuk key yang belum terisi.
 */
export function loadEnvFiles() {
  if (envLoaded) return;
  const candidates = [
    path.join(BOT_ROOT, ".env.local"),
    path.join(BOT_ROOT, ".env"),
    path.join(REPO_ROOT, ".env.local"),
    path.join(REPO_ROOT, ".env"),
  ];
  for (const filePath of candidates) {
    parseAndInjectEnv(filePath);
  }
  envLoaded = true;
}

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * Membaca dan menormalisasi seluruh konfigurasi bot WhatsApp NOVA.
 */
export function loadConfig() {
  loadEnvFiles();

  const rawGroupMode = String(process.env.GROUP_MODE || "mention")
    .trim()
    .toLowerCase();
  const groupMode = ["off", "mention", "all"].includes(rawGroupMode) ? rawGroupMode : "mention";

  const allowedNumbers = [
    ...new Set(
      String(process.env.ALLOWED_NUMBERS || "")
        .split(",")
        .map((n) => sanitizePhoneNumber(n))
        .filter(Boolean)
    ),
  ];

  const authDirRaw = (process.env.WA_AUTH_DIR || "auth_info").trim();
  const authDir = path.isAbsolute(authDirRaw) ? authDirRaw : path.resolve(BOT_ROOT, authDirRaw);

  const sqliteRaw = (process.env.SQLITE_DB_PATH || "").trim();
  const sqliteDbPath = sqliteRaw
    ? path.isAbsolute(sqliteRaw)
      ? sqliteRaw
      : path.resolve(BOT_ROOT, sqliteRaw)
    : path.join(BOT_ROOT, ".tmp", "nova_whatsapp.db");

  return {
    botRoot: BOT_ROOT,
    geminiApiKey: (process.env.GEMINI_API_KEY || "").trim(),
    geminiModel: (process.env.GEMINI_MODEL || "gemini-2.5-flash-lite").trim(),
    waPhoneNumber: sanitizePhoneNumber(process.env.WA_PHONE_NUMBER || ""),
    authDir,
    botName: (process.env.BOT_NAME || "NOVA").trim() || "NOVA",
    commandPrefix: (process.env.BOT_PREFIX || "!").trim() || "!",
    groupMode,
    ignoreArchived: String(process.env.IGNORE_ARCHIVED ?? "true").trim().toLowerCase() !== "false",
    allowedNumbers,
    maxHistoryMessages: clampInt(process.env.MAX_HISTORY_MESSAGES, 10, 2, 30),
    cooldownMs: clampInt(process.env.COOLDOWN_MS, 1500, 0, 60000),
    healthPort: clampInt(process.env.HEALTH_PORT, 0, 0, 65535),
    healthHost: (process.env.HEALTH_HOST || "127.0.0.1").trim() || "127.0.0.1",
    logLevel: (process.env.LOG_LEVEL || "silent").trim() || "silent",
    tursoUrl: (
      process.env.TURSO_DATABASE_URL ||
      process.env.LIBSQL_URL ||
      process.env.DATABASE_URL ||
      ""
    ).trim(),
    tursoAuthToken: (
      process.env.TURSO_AUTH_TOKEN ||
      process.env.LIBSQL_AUTH_TOKEN ||
      ""
    ).trim(),
    sqliteDbPath,
  };
}
