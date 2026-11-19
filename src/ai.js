import { SYSTEM_PROMPT } from "./system-prompt.js";

export const FALLBACK_MODELS = [
  "gemini-flash-lite-latest",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-flash-latest",
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash",
];

const CONNECT_TIMEOUT_MS = 10000;
const READ_TIMEOUT_MS = 45000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let workingModel = null;

/**
 * Mengembalikan nama model Gemini yang sedang aktif digunakan.
 */
export function getActiveModel(defaultModel = "gemini-flash-lite-latest") {
  return workingModel || defaultModel || FALLBACK_MODELS[0];
}

function parseSseDataLine(rawLine) {
  const line = rawLine.trim();
  if (!line.startsWith("data:")) return "";
  const json = line.slice(5).trim();
  if (!json || json === "[DONE]") return "";

  try {
    const parts = JSON.parse(json)?.candidates?.[0]?.content?.parts || [];
    let out = "";
    for (const part of parts) {
      // Abaikan ringkasan reasoning agar tidak ikut terkirim ke chat WhatsApp
      if (!part.text || part.thought) continue;
      out += part.text;
    }
    return out;
  } catch {
    return "";
  }
}

async function readGeminiSseReply(bodyStream) {
  const reader = bodyStream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullReply = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      fullReply += parseSseDataLine(line);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    fullReply += parseSseDataLine(buffer);
  }

  return fullReply.trim();
}

/**
 * Memanggil Gemini API dengan rantai failover model yang identik dengan api/chat.js.
 */
export async function generateReply({ apiKey, defaultModel, messages }) {
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY belum dikonfigurasi.");
  }

  const normalizedMessages = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && typeof m.content === "string" && m.content.trim())
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content.slice(0, 4000) }],
    }));

  if (normalizedMessages.length === 0) {
    throw new Error("Tidak ada pesan valid untuk dikirim ke AI.");
  }

  const candidateModels = [
    ...new Set([workingModel, defaultModel, ...FALLBACK_MODELS].filter(Boolean)),
  ];

  let attempts = 0;
  let lastErrorDetail = "";
  let lastStatus = 502;

  for (const modelName of candidateModels) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?alt=sse`;
    attempts++;

    const ac = new AbortController();
    const connectTimer = setTimeout(() => ac.abort(), CONNECT_TIMEOUT_MS);
    let readTimer = null;

    try {
      const resp = await fetch(url, {
        method: "POST",
        signal: ac.signal,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: normalizedMessages,
          generationConfig: {
            temperature: 0.7,
            topP: 0.9,
            maxOutputTokens: 1024,
          },
        }),
      });

      clearTimeout(connectTimer);

      if (resp.ok && resp.body) {
        readTimer = setTimeout(() => ac.abort(), READ_TIMEOUT_MS);
        const replyText = await readGeminiSseReply(resp.body);
        clearTimeout(readTimer);

        if (replyText) {
          workingModel = modelName;
          return { text: replyText, model: modelName, attempts };
        }

        lastStatus = 502;
        lastErrorDetail = `Model ${modelName} mengembalikan respons kosong.`;
        await sleep(250);
        continue;
      }

      lastStatus = resp.status || 502;
      try {
        lastErrorDetail = (await resp.json())?.error?.message || "";
      } catch {}

      const isRetryable =
        [404, 429, 500, 502, 503, 504].includes(resp.status) ||
        /no longer available|high demand|overloaded|unavailable|resource exhausted|try again/i.test(
          lastErrorDetail
        );

      if (!isRetryable) {
        console.warn(`[AI] Model ${modelName} ditolak (${resp.status}): ${lastErrorDetail}`);
        break;
      }

      console.warn(`[AI] Model ${modelName} gagal (${resp.status}), beralih ke fallback...`);
      await sleep(250);
    } catch (err) {
      clearTimeout(connectTimer);
      if (readTimer) clearTimeout(readTimer);
      lastErrorDetail =
        err?.name === "AbortError"
          ? "Timeout saat menghubungi Gemini API."
          : err?.message || "Gagal menghubungi Gemini API.";
      console.warn(`[AI] Model ${modelName} error: ${lastErrorDetail}`);
      if (workingModel === modelName) workingModel = null;
      await sleep(250);
    }
  }

  throw new Error(lastErrorDetail || `Gemini API gagal dengan status ${lastStatus}`);
}
