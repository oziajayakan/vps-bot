/**
 * Membersihkan dan menormalisasi nomor telepon ke format digit internasional (mis. 6281234567890).
 * Mengubah awalan "0" (format lokal Indonesia) menjadi "62".
 * Mengembalikan string kosong jika panjang digit tidak valid (< 8 atau > 15).
 */
export function sanitizePhoneNumber(raw) {
  if (raw === null || raw === undefined) return "";
  let digits = String(raw).replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("0")) {
    digits = "62" + digits.slice(1);
  }
  if (digits.length < 8 || digits.length > 15) {
    return "";
  }
  return digits;
}

/**
 * Memformat kode pairing 8 karakter dari Baileys menjadi XXXX-XXXX agar mudah dibaca di terminal.
 */
export function formatPairingCode(code) {
  const clean = String(code || "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
  if (clean.length === 8) {
    return `${clean.slice(0, 4)}-${clean.slice(4)}`;
  }
  return clean || String(code || "").trim();
}

/**
 * Mengekstrak bagian user ID sebelum ":" dan "@" dari JID WhatsApp apa pun (@s.whatsapp.net, @lid, dll.).
 */
export function extractJidUser(jid) {
  if (!jid || typeof jid !== "string") return "";
  return jid.split("@")[0].split(":")[0].trim();
}

/**
 * Mengekstrak nomor telepon (digit) dari JID WhatsApp Phone Number (PN) seperti "6281234:12@s.whatsapp.net".
 * Mengembalikan string kosong untuk non-PN JID seperti "@lid", "@g.us", atau "@broadcast".
 */
export function extractPhoneFromJid(jid) {
  if (!jid || typeof jid !== "string") return "";
  if (jid.includes("@") && !jid.endsWith("@s.whatsapp.net") && !jid.endsWith("@c.us")) {
    return "";
  }
  const userPart = extractJidUser(jid);
  const digits = userPart.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15 ? digits : "";
}

/**
 * Membuka pembungkus pesan WhatsApp (ephemeral, viewOnce, documentWithCaption, editedMessage).
 */
export function unwrapMessage(message, maxDepth = 8) {
  let current = message;
  let depth = 0;

  while (current && typeof current === "object" && depth < maxDepth) {
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
    } else if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
    } else if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message;
    } else if (current.viewOnceMessageV2Extension?.message) {
      current = current.viewOnceMessageV2Extension.message;
    } else if (current.documentWithCaptionMessage?.message) {
      current = current.documentWithCaptionMessage.message;
    } else if (current.editedMessage?.message) {
      current = current.editedMessage.message;
    } else if (current.protocolMessage?.editedMessage) {
      current = current.protocolMessage.editedMessage;
    } else {
      break;
    }
    depth++;
  }

  return current || null;
}

function extractTextFromContent(content) {
  if (!content || typeof content !== "object") return "";
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.listResponseMessage?.title ||
    content.templateButtonReplyMessage?.selectedDisplayText ||
    ""
  );
}

/**
 * Mengekstrak teks pesan, teks pesan yang dikutip (reply), dan contextInfo dari objek pesan Baileys.
 */
export function extractMessagePayload(msg) {
  const content = unwrapMessage(msg?.message);
  if (!content) {
    return { text: "", quotedText: "", contextInfo: null };
  }

  const text = String(extractTextFromContent(content)).trim();
  const contextInfo =
    content.extendedTextMessage?.contextInfo ||
    content.imageMessage?.contextInfo ||
    content.videoMessage?.contextInfo ||
    content.documentMessage?.contextInfo ||
    content.buttonsResponseMessage?.contextInfo ||
    content.listResponseMessage?.contextInfo ||
    null;

  let quotedText = "";
  if (contextInfo?.quotedMessage) {
    const unwrappedQuote = unwrapMessage(contextInfo.quotedMessage);
    quotedText = String(extractTextFromContent(unwrappedQuote)).trim();
  }

  return { text, quotedText, contextInfo };
}

function convertMarkdownSegment(segment) {
  return segment
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)")
    .replace(/\*\*([^*\n]+?)\*\*/g, "*$1*")
    .replace(/__([^_\n]+?)__/g, "*$1*")
    .replace(/~~([^~\n]+?)~~/g, "~$1~");
}

/**
 * Mengonversi Markdown standar dari AI menjadi format yang rapi di WhatsApp,
 * sambil mempertahankan isi blok kode (```...```) dan inline code (`...`) tanpa diubah.
 */
export function formatForWhatsApp(markdown) {
  if (!markdown || typeof markdown !== "string") return "";

  const fencedParts = markdown.split(/(```[\s\S]*?```)/g);
  const transformed = fencedParts
    .map((part) => {
      if (part.startsWith("```") && part.endsWith("```")) {
        return part;
      }
      const inlineParts = part.split(/(`[^`\n]+`)/g);
      return inlineParts
        .map((sub) => {
          if (sub.startsWith("`") && sub.endsWith("`")) {
            return sub;
          }
          return convertMarkdownSegment(sub);
        })
        .join("");
    })
    .join("");

  return transformed.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Memecah pesan panjang agar nyaman dikirim lewat WhatsApp tanpa memutus paragraf atau kata secara kasar.
 */
export function splitLongMessage(text, maxLen = 3800) {
  const normalized = String(text || "").trim();
  if (!normalized) return [];
  if (normalized.length <= maxLen) return [normalized];

  const chunks = [];
  let remaining = normalized;
  const minCut = Math.floor(maxLen * 0.4);

  while (remaining.length > maxLen) {
    const windowSlice = remaining.slice(0, maxLen);
    let splitIdx = windowSlice.lastIndexOf("\n\n");
    if (splitIdx < minCut) splitIdx = windowSlice.lastIndexOf("\n");
    if (splitIdx < minCut) splitIdx = windowSlice.lastIndexOf(" ");
    if (splitIdx <= 0) splitIdx = maxLen;

    const chunk = remaining.slice(0, splitIdx).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitIdx).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}
