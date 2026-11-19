import fs from "node:fs";
import path from "node:path";

/**
 * Database Manager untuk NOVA WhatsApp Bot:
 * Skema tabel IDENTIK dengan api/db.js (conversations & messages) sehingga
 * dapat berbagi database Turso Cloud yang sama atau berjalan mandiri di SQLite / JSON lokal.
 */

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );`,
  `CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);`,
];

async function createTursoStore(tursoUrl, tursoAuthToken) {
  const { createClient } = await import("@libsql/client");
  const client = createClient({
    url: tursoUrl,
    authToken: tursoAuthToken || undefined,
  });

  await client.batch(SCHEMA_SQL);

  return {
    engine: "Turso LibSQL (Cloud SQLite)",
    isCloud: true,

    async getConversation(id) {
      const convRes = await client.execute({
        sql: `SELECT * FROM conversations WHERE id = ?`,
        args: [id],
      });
      if (convRes.rows.length === 0) return null;
      const conv = convRes.rows[0];

      const msgRes = await client.execute({
        sql: `SELECT id, conversation_id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC`,
        args: [id],
      });

      return {
        id: String(conv.id),
        title: String(conv.title),
        created_at: String(conv.created_at),
        updated_at: String(conv.updated_at),
        messages: msgRes.rows.map((m) => ({
          id: Number(m.id),
          conversation_id: String(m.conversation_id),
          role: String(m.role),
          content: String(m.content),
          created_at: String(m.created_at),
        })),
      };
    },

    async getRecentMessages(conversationId, limit = 20) {
      const res = await client.execute({
        sql: `SELECT id, conversation_id, role, content, created_at
              FROM messages
              WHERE conversation_id = ?
              ORDER BY id DESC
              LIMIT ?`,
        args: [conversationId, Number(limit)],
      });
      return res.rows
        .map((m) => ({
          id: Number(m.id),
          conversation_id: String(m.conversation_id),
          role: String(m.role),
          content: String(m.content),
          created_at: String(m.created_at),
        }))
        .reverse();
    },

    async countMessages(conversationId) {
      const res = await client.execute({
        sql: `SELECT COUNT(id) AS total FROM messages WHERE conversation_id = ?`,
        args: [conversationId],
      });
      return Number(res.rows[0]?.total || 0);
    },

    async addMessage(conversationId, { role, content, title }) {
      const now = new Date().toISOString();
      const check = await client.execute({
        sql: `SELECT id FROM conversations WHERE id = ?`,
        args: [conversationId],
      });

      if (check.rows.length === 0) {
        const autoTitle = (title || content.slice(0, 50).trim() || "Chat WhatsApp").slice(0, 120);
        await client.execute({
          sql: `INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
          args: [conversationId, autoTitle, now, now],
        });
      } else {
        await client.execute({
          sql: `UPDATE conversations SET updated_at = ? WHERE id = ?`,
          args: [now, conversationId],
        });
      }

      const res = await client.execute({
        sql: `INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)`,
        args: [conversationId, role, content, now],
      });

      return {
        id: Number(res.lastInsertRowid),
        conversation_id: conversationId,
        role,
        content,
        created_at: now,
      };
    },

    async resetConversation(conversationId) {
      await client.execute({ sql: `DELETE FROM messages WHERE conversation_id = ?`, args: [conversationId] });
      const res = await client.execute({ sql: `DELETE FROM conversations WHERE id = ?`, args: [conversationId] });
      return res.rowsAffected > 0;
    },

    async close() {
      if (typeof client.close === "function") {
        client.close();
      }
    },
  };
}

async function createSqliteStore(dbPath) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);

  db.exec(`
    PRAGMA foreign_keys = ON;
    ${SCHEMA_SQL.join("\n")}
  `);

  return {
    engine: "node:sqlite (Local SQLite3)",
    isCloud: false,
    dbPath,

    async getConversation(id) {
      const conv = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id);
      if (!conv) return null;
      const messages = db
        .prepare(
          `SELECT id, conversation_id, role, content, created_at
           FROM messages
           WHERE conversation_id = ?
           ORDER BY id ASC`
        )
        .all(id);
      return { ...conv, messages };
    },

    async getRecentMessages(conversationId, limit = 20) {
      const rows = db
        .prepare(
          `SELECT id, conversation_id, role, content, created_at
           FROM messages
           WHERE conversation_id = ?
           ORDER BY id DESC
           LIMIT ?`
        )
        .all(conversationId, Number(limit));
      return rows.reverse();
    },

    async countMessages(conversationId) {
      const row = db
        .prepare(`SELECT COUNT(id) AS total FROM messages WHERE conversation_id = ?`)
        .get(conversationId);
      return Number(row?.total || 0);
    },

    async addMessage(conversationId, { role, content, title }) {
      const now = new Date().toISOString();
      const check = db.prepare(`SELECT id FROM conversations WHERE id = ?`).get(conversationId);

      if (!check) {
        const autoTitle = (title || content.slice(0, 50).trim() || "Chat WhatsApp").slice(0, 120);
        db.prepare(`INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
          conversationId,
          autoTitle,
          now,
          now
        );
      } else {
        db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(now, conversationId);
      }

      const res = db
        .prepare(`INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)`)
        .run(conversationId, role, content, now);

      return {
        id: Number(res.lastInsertRowid),
        conversation_id: conversationId,
        role,
        content,
        created_at: now,
      };
    },

    async resetConversation(conversationId) {
      db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(conversationId);
      const res = db.prepare(`DELETE FROM conversations WHERE id = ?`).run(conversationId);
      return res.changes > 0;
    },

    async close() {
      db.close();
    },
  };
}

function createJsonFallbackStore(dbPath) {
  const jsonPath = `${dbPath}.json`;

  const loadStore = () => {
    try {
      if (fs.existsSync(jsonPath)) {
        return JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      }
    } catch {}
    return { conversations: [], messages: [], seq: 1 };
  };

  const saveStore = (data) => {
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), "utf8");
  };

  return {
    engine: "JSON File Fallback Store",
    isCloud: false,
    dbPath: jsonPath,

    async getConversation(id) {
      const store = loadStore();
      const conv = store.conversations.find((c) => c.id === id);
      if (!conv) return null;
      const messages = store.messages.filter((m) => m.conversation_id === id).sort((a, b) => a.id - b.id);
      return { ...conv, messages };
    },

    async getRecentMessages(conversationId, limit = 20) {
      const store = loadStore();
      return store.messages
        .filter((m) => m.conversation_id === conversationId)
        .sort((a, b) => a.id - b.id)
        .slice(-Number(limit));
    },

    async countMessages(conversationId) {
      const store = loadStore();
      return store.messages.filter((m) => m.conversation_id === conversationId).length;
    },

    async addMessage(conversationId, { role, content, title }) {
      const store = loadStore();
      const now = new Date().toISOString();
      let conv = store.conversations.find((c) => c.id === conversationId);
      if (!conv) {
        conv = {
          id: conversationId,
          title: (title || content.slice(0, 50).trim() || "Chat WhatsApp").slice(0, 120),
          created_at: now,
          updated_at: now,
        };
        store.conversations.push(conv);
      } else {
        conv.updated_at = now;
      }

      const msg = {
        id: store.seq++,
        conversation_id: conversationId,
        role,
        content,
        created_at: now,
      };
      store.messages.push(msg);
      saveStore(store);
      return msg;
    },

    async resetConversation(conversationId) {
      const store = loadStore();
      const beforeConv = store.conversations.length;
      const beforeMsg = store.messages.length;
      store.conversations = store.conversations.filter((c) => c.id !== conversationId);
      store.messages = store.messages.filter((m) => m.conversation_id !== conversationId);
      saveStore(store);
      return store.conversations.length < beforeConv || store.messages.length < beforeMsg;
    },

    async close() {},
  };
}

/**
 * Menginisialisasi instance database sesuai konfigurasi (Turso Cloud -> node:sqlite -> JSON fallback).
 */
export async function getDb(config) {
  if (config.tursoUrl && !config.tursoUrl.startsWith("file:")) {
    try {
      return await createTursoStore(config.tursoUrl, config.tursoAuthToken);
    } catch (err) {
      console.warn(`[DB] Koneksi Turso Cloud gagal (${err.message}), beralih ke SQLite lokal.`);
    }
  }

  const dbDir = path.dirname(config.sqliteDbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  try {
    return await createSqliteStore(config.sqliteDbPath);
  } catch (err) {
    console.warn(`[DB] node:sqlite tidak tersedia (${err.message}), memakai JSON File Fallback.`);
    return createJsonFallbackStore(config.sqliteDbPath);
  }
}
