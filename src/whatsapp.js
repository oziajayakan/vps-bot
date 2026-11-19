import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { generateReply, getActiveModel } from "./ai.js";
import {
  extractJidUser,
  extractMessagePayload,
  extractPhoneFromJid,
  formatForWhatsApp,
  formatPairingCode,
  sanitizePhoneNumber,
  splitLongMessage,
} from "./utils.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toUnixSeconds(ts) {
  if (!ts) return 0;
  if (typeof ts === "number") return ts;
  if (typeof ts === "bigint") return Number(ts);
  if (typeof ts.toNumber === "function") return ts.toNumber();
  const parsed = Number(ts);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatUptime(totalSeconds) {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  const remSec = sec % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}h`);
  if (hours > 0) parts.push(`${hours}j`);
  if (mins > 0) parts.push(`${mins}m`);
  parts.push(`${remSec}d`);
  return parts.join(" ");
}

async function resolvePairingPhoneNumber(configPhone) {
  if (configPhone) {
    return configPhone;
  }

  if (!process.stdin.isTTY) {
    console.error("\n[WA] Sesi WhatsApp belum terdaftar dan proses berjalan tanpa terminal interaktif.");
    console.error("[WA] Solusi untuk VPS:");
    console.error("     1) Isi WA_PHONE_NUMBER=6281234567890 di file whatsapp-bot/.env, ATAU");
    console.error("     2) Jalankan 'npm run pair' sekali lewat terminal SSH untuk pairing pertama.\n");
    throw new Error("WA_PHONE_NUMBER belum diatur pada environment non-interaktif.");
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const answer = await rl.question(
        "\n📱 Masukkan nomor WhatsApp bot untuk Pairing Code (contoh 6281234567890): "
      );
      const sanitized = sanitizePhoneNumber(answer);
      if (sanitized) {
        return sanitized;
      }
      console.log("⚠️  Format nomor tidak valid. Masukkan 8-15 digit angka (contoh: 6281234567890).");
    }
  } finally {
    rl.close();
  }
}

function printPairingBanner(phoneNumber, rawCode) {
  const formatted = formatPairingCode(rawCode);
  console.log("\n====================================================");
  console.log(`  KODE PAIRING WHATSAPP (${phoneNumber})`);
  console.log(`  >>>   ${formatted}   <<<`);
  console.log("====================================================");
  console.log("Cara menautkan di HP:");
  console.log("  1. Buka WhatsApp -> Setelan -> Perangkat Tertaut");
  console.log("  2. Ketuk 'Tautkan Perangkat'");
  console.log("  3. Pilih 'Tautkan dengan nomor telepon saja' di bawah");
  console.log(`  4. Masukkan kode: ${formatted}`);
  console.log("====================================================\n");
}

/**
 * Memulai client WhatsApp berbasis Baileys v7 dengan dukungan Pairing Code dan auto-reconnect 24/7.
 */
export async function startWhatsAppBot({ config, db, forcePairNotice = false }) {
  const botStartedAtMs = Date.now();
  const botStartedAtSec = Math.floor(botStartedAtMs / 1000);
  const baileysLogger = pino({ level: config.logLevel });

  const chatQueues = new Map();
  const lastReplyByChat = new Map();

  // Penyimpanan daftar JID chat/grup yang diarsipkan agar tetap terjaga saat bot restart
  const archivedStorePath = path.join(config.authDir, "archived-chats.json");
  const archivedChats = new Set();
  try {
    if (fs.existsSync(archivedStorePath)) {
      const saved = JSON.parse(fs.readFileSync(archivedStorePath, "utf8"));
      if (Array.isArray(saved)) {
        for (const jid of saved) {
          if (typeof jid === "string" && jid) archivedChats.add(jid);
        }
      }
    }
  } catch {}

  function saveArchivedChats() {
    try {
      if (!fs.existsSync(config.authDir)) {
        fs.mkdirSync(config.authDir, { recursive: true });
      }
      fs.writeFileSync(archivedStorePath, JSON.stringify([...archivedChats], null, 2), "utf8");
    } catch {}
  }

  function syncArchivedState(chatsList) {
    if (!Array.isArray(chatsList) || chatsList.length === 0) return;
    let changed = false;
    for (const chat of chatsList) {
      if (!chat?.id || typeof chat.archived !== "boolean") continue;
      if (chat.archived) {
        if (!archivedChats.has(chat.id)) {
          archivedChats.add(chat.id);
          changed = true;
        }
      } else if (archivedChats.delete(chat.id)) {
        changed = true;
      }
    }
    if (changed) {
      saveArchivedChats();
    }
  }

  let activeSock = null;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let isStopping = false;
  let connectionState = "connecting";
  let connectedUser = null;
  let cachedPairingPhone = config.waPhoneNumber;

  function enqueueChatTask(chatId, taskFn) {
    const prev = chatQueues.get(chatId) || Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(taskFn)
      .finally(() => {
        if (chatQueues.get(chatId) === next) {
          chatQueues.delete(chatId);
        }
      });
    chatQueues.set(chatId, next);
    return next;
  }

  function buildHelpMessage() {
    const p = config.commandPrefix;
    return [
      `🤖 *${config.botName} AI Assistant*`,
      "",
      "Kirim pesan langsung di chat pribadi untuk ngobrol dengan AI.",
      "",
      "*Daftar Perintah:*",
      `• *${p}help* / *${p}menu* — Lihat panduan perintah`,
      `• *${p}reset* / *${p}clear* — Hapus riwayat konteks chat ini`,
      `• *${p}status* — Cek status bot, model AI & database`,
      `• *${p}ai <pertanyaan>* — Panggil AI secara eksplisit (berguna di grup)`,
      "",
      `Mode grup saat ini: *${config.groupMode}*`,
    ].join("\n");
  }

  async function resolveSenderPhone(sock, senderJid, senderJidAlt) {
    const direct = extractPhoneFromJid(senderJid) || extractPhoneFromJid(senderJidAlt);
    if (direct) return direct;

    if (senderJid?.endsWith("@lid") && sock.signalRepository?.lidMapping?.getPNForLID) {
      try {
        const mapped = await sock.signalRepository.lidMapping.getPNForLID(senderJid);
        const mappedPhone = extractPhoneFromJid(mapped);
        if (mappedPhone) return mappedPhone;
      } catch {}
    }
    return "";
  }

  async function processIncomingMessage(sock, msg) {
    const remoteJid = msg?.key?.remoteJid || "";
    const remoteJidAlt = msg?.key?.remoteJidAlt || "";
    if (!remoteJid || msg.key.fromMe) return;
    if (
      remoteJid === "status@broadcast" ||
      remoteJid.endsWith("@broadcast") ||
      remoteJid.endsWith("@newsletter")
    ) {
      return;
    }

    if (
      config.ignoreArchived &&
      (archivedChats.has(remoteJid) || (remoteJidAlt && archivedChats.has(remoteJidAlt)))
    ) {
      return;
    }

    const msgTs = toUnixSeconds(msg.messageTimestamp);
    if (msgTs > 0 && msgTs < botStartedAtSec - 300) {
      return;
    }

    const { text, quotedText, contextInfo } = extractMessagePayload(msg);
    if (!text) return;

    const isGroup = remoteJid.endsWith("@g.us");
    if (isGroup && config.groupMode === "off") {
      return;
    }

    const senderJid = isGroup ? msg.key.participant || "" : remoteJid;
    const senderJidAlt = isGroup ? msg.key.participantAlt || "" : msg.key.remoteJidAlt || "";
    const senderPhone = await resolveSenderPhone(sock, senderJid, senderJidAlt);

    if (config.allowedNumbers.length > 0) {
      const normalizedSender = sanitizePhoneNumber(senderPhone);
      if (!normalizedSender || !config.allowedNumbers.includes(normalizedSender)) {
        return;
      }
    }

    const prefix = config.commandPrefix;
    const escapedPrefix = escapeRegExp(prefix);
    const cmdMatch = text.match(
      new RegExp(`^${escapedPrefix}(help|menu|reset|clear|status|ai|nova)(?:\\s+([\\s\\S]*))?$`, "i")
    );
    const cmdName = cmdMatch ? cmdMatch[1].toLowerCase() : "";
    const cmdArg = cmdMatch ? (cmdMatch[2] || "").trim() : "";

    const myPnUser = extractJidUser(sock.user?.id || "");
    const myLidUser = extractJidUser(sock.user?.lid || "");

    const mentionedJids = Array.isArray(contextInfo?.mentionedJid) ? contextInfo.mentionedJid : [];
    const isBotMentioned = mentionedJids.some((jid) => {
      const u = extractJidUser(jid);
      return Boolean(u && (u === myPnUser || u === myLidUser));
    });

    const quotedUser = extractJidUser(contextInfo?.participant || "");
    const isReplyToBot = Boolean(quotedUser && (quotedUser === myPnUser || quotedUser === myLidUser));

    if (isGroup && config.groupMode === "mention") {
      if (!cmdName && !isBotMentioned && !isReplyToBot) {
        return;
      }
    }

    // Cooldown anti-spam per chat (perintah !help / !status tetap cepat atau ikut dijaga ringan)
    const now = Date.now();
    const lastTime = lastReplyByChat.get(remoteJid) || 0;
    if (config.cooldownMs > 0 && now - lastTime < config.cooldownMs) {
      return;
    }
    lastReplyByChat.set(remoteJid, now);

    const convId = `wa_${remoteJid}`;
    const convTitle = isGroup
      ? `Grup WA (${extractJidUser(remoteJid)})`
      : msg.pushName
        ? `WA: ${msg.pushName}`
        : `WA: ${senderPhone || extractJidUser(remoteJid)}`;

    await enqueueChatTask(remoteJid, async () => {
      if (isStopping) return;

      if (cmdName === "help" || cmdName === "menu") {
        await sock.sendMessage(remoteJid, { text: buildHelpMessage() }, { quoted: msg });
        return;
      }

      if (cmdName === "reset" || cmdName === "clear") {
        await db.resetConversation(convId);
        await sock.sendMessage(
          remoteJid,
          { text: "🧹 Riwayat percakapan pada chat ini telah dibersihkan. Yuk mulai topik baru!" },
          { quoted: msg }
        );
        return;
      }

      if (cmdName === "status") {
        const count = await db.countMessages(convId).catch(() => 0);
        const statusText = [
          `📊 *Status ${config.botName} Bot*`,
          `• Koneksi: *${connectionState}*`,
          `• Model AI Aktif: \`${getActiveModel(config.geminiModel)}\``,
          `• Database: ${db.engine}`,
          `• Pesan di chat ini: ${count}`,
          `• Uptime: ${formatUptime((Date.now() - botStartedAtMs) / 1000)}`,
        ].join("\n");
        await sock.sendMessage(remoteJid, { text: statusText }, { quoted: msg });
        return;
      }

      let promptText = cmdName === "ai" || cmdName === "nova" ? cmdArg : text;

      if (myPnUser) {
        promptText = promptText.replace(new RegExp(`@${escapeRegExp(myPnUser)}\\b`, "g"), "").trim();
      }
      if (myLidUser) {
        promptText = promptText.replace(new RegExp(`@${escapeRegExp(myLidUser)}\\b`, "g"), "").trim();
      }

      if (!promptText) {
        await sock.sendMessage(
          remoteJid,
          { text: `Halo! Ketik pertanyaan setelah perintah, contoh: *${prefix}ai jelaskan apa itu cloud computing*` },
          { quoted: msg }
        );
        return;
      }

      const fullPrompt = quotedText
        ? `[Konteks pesan yang dibalas: "${quotedText.slice(0, 1000)}"]\n\n${promptText}`
        : promptText;

      await sock.sendPresenceUpdate("composing", remoteJid).catch(() => {});

      try {
        await db.addMessage(convId, {
          role: "user",
          content: fullPrompt,
          title: convTitle,
        });

        const historyMessages = await db.getRecentMessages(convId, config.maxHistoryMessages);
        const aiMessages =
          historyMessages.length > 0
            ? historyMessages
            : [{ role: "user", content: fullPrompt }];

        const reply = await generateReply({
          apiKey: config.geminiApiKey,
          defaultModel: config.geminiModel,
          messages: aiMessages,
        });

        await db.addMessage(convId, {
          role: "assistant",
          content: reply.text,
          title: convTitle,
        });

        const formatted = formatForWhatsApp(reply.text);
        const withFooter = config.botFooter
          ? `${formatted}\n\n${config.botFooter}`
          : formatted;
        const chunks = splitLongMessage(withFooter, 3800);
        if (chunks.length === 0) return;

        for (let i = 0; i < chunks.length; i++) {
          await sock.sendMessage(
            remoteJid,
            { text: chunks[i] },
            i === 0 ? { quoted: msg } : undefined
          );
        }
      } catch (err) {
        console.error(`[AI ERROR] (${remoteJid}):`, err?.message || err);
        await sock
          .sendMessage(
            remoteJid,
            {
              text: "⚠️ Maaf, terjadi gangguan saat menghubungi AI. Coba kirim ulang sebentar lagi ya.",
            },
            { quoted: msg }
          )
          .catch(() => {});
      } finally {
        await sock.sendPresenceUpdate("paused", remoteJid).catch(() => {});
      }
    });
  }

  async function connectSocket() {
    if (isStopping) return;

    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);

    if (!state.creds.registered) {
      cachedPairingPhone = await resolvePairingPhoneNumber(cachedPairingPhone);
      console.log(`[WA] Menyiapkan Pairing Code untuk nomor ${cachedPairingPhone}...`);
    } else if (forcePairNotice && reconnectAttempts === 0) {
      console.log(
        `[WA] Sesi sudah terdaftar di ${config.authDir}. Jika ingin pairing nomor baru, jalankan: npm run reset-auth`
      );
    }

    let waVersion;
    try {
      const latest = await fetchLatestBaileysVersion();
      waVersion = latest.version;
      console.log(`[WA] Menggunakan protokol WhatsApp Web v${waVersion.join(".")}`);
    } catch {
      console.warn("[WA] Gagal mengecek versi WA terbaru, memakai versi bawaan Baileys.");
    }

    const sock = makeWASocket({
      ...(waVersion ? { version: waVersion } : {}),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      browser: Browsers.ubuntu("Chrome"),
      logger: baileysLogger,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
    });

    activeSock = sock;
    let socketClosed = false;
    let pairingRequested = false;

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("messaging-history.set", ({ chats }) => syncArchivedState(chats));
    sock.ev.on("chats.upsert", (chats) => syncArchivedState(chats));
    sock.ev.on("chats.update", (updates) => syncArchivedState(updates));

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (
        !state.creds.registered &&
        !pairingRequested &&
        (connection === "connecting" || Boolean(qr))
      ) {
        pairingRequested = true;
        try {
          await sleep(2500);
          if (socketClosed || isStopping || state.creds.registered) return;
          const code = await sock.requestPairingCode(cachedPairingPhone);
          printPairingBanner(cachedPairingPhone, code);
        } catch (err) {
          console.error("[WA] Gagal meminta Pairing Code:", err?.message || err);
        }
      }

      if (connection === "open") {
        reconnectAttempts = 0;
        connectionState = "open";
        connectedUser = {
          id: sock.user?.id || "",
          lid: sock.user?.lid || "",
          name: sock.user?.name || config.botName,
        };
        console.log(
          `✅ [WA] Terhubung ke WhatsApp sebagai ${connectedUser.name} (${extractJidUser(connectedUser.id) || "terhubung"})`
        );
        console.log(
          `🧠 [AI] Model aktif: ${getActiveModel(config.geminiModel)} | Database: ${db.engine}`
        );
      } else if (connection === "close") {
        socketClosed = true;
        connectionState = "closed";

        sock.ev.removeAllListeners("creds.update");
        sock.ev.removeAllListeners("messaging-history.set");
        sock.ev.removeAllListeners("chats.upsert");
        sock.ev.removeAllListeners("chats.update");
        sock.ev.removeAllListeners("connection.update");
        sock.ev.removeAllListeners("messages.upsert");

        if (isStopping) return;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reasonText = lastDisconnect?.error?.message || "Koneksi terputus";

        if (statusCode === DisconnectReason.loggedOut) {
          connectionState = "logged_out";
          console.error(
            `❌ [WA] Sesi WhatsApp keluar/logged out (status ${statusCode}). Jalankan 'npm run reset-auth' lalu pairing ulang.`
          );
          return;
        }

        if (statusCode === DisconnectReason.connectionReplaced) {
          console.error(
            "❌ [WA] Koneksi digantikan oleh sesi lain (440 connectionReplaced). Pastikan hanya 1 instance bot yang berjalan."
          );
          return;
        }

        const delayMs =
          statusCode === DisconnectReason.restartRequired
            ? 1000
            : Math.min(3000 * 2 ** reconnectAttempts, 60000);

        if (statusCode !== DisconnectReason.restartRequired) {
          reconnectAttempts++;
        }

        console.warn(
          `🔄 [WA] Terputus (status: ${statusCode ?? "unknown"} - ${reasonText}). Menyambung ulang dalam ${Math.round(delayMs / 1000)} detik...`
        );

        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          connectSocket().catch((err) => {
            console.error("[WA] Gagal menyambung ulang:", err?.message || err);
          });
        }, delayMs);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify" || !Array.isArray(messages)) return;
      for (const msg of messages) {
        processIncomingMessage(sock, msg).catch((err) => {
          console.error("[WA] Error saat memproses pesan:", err?.message || err);
        });
      }
    });
  }

  await connectSocket();

  return {
    getStatus() {
      return {
        connectionState,
        user: connectedUser,
        reconnectAttempts,
        activeModel: getActiveModel(config.geminiModel),
      };
    },
    async stop() {
      isStopping = true;
      clearTimeout(reconnectTimer);
      if (activeSock) {
        try {
          activeSock.ev.removeAllListeners("creds.update");
          activeSock.ev.removeAllListeners("connection.update");
          activeSock.ev.removeAllListeners("messages.upsert");
          activeSock.ws?.close();
        } catch {}
      }
    },
  };
}
