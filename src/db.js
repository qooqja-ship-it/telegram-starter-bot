// База данных бота: SQLite через better-sqlite3.
//
// Путь к файлу задаётся переменной окружения DATA_DIR. На FadeHost данные,
// которые должны переживать пересоздание контейнера, лежат в /data, поэтому
// там нужно задать DATA_DIR=/data/bot-data. Если папку создать не удалось,
// молча откатываемся в ./data — бот продолжит работать, просто память
// будет жить рядом с кодом.

import Database from "better-sqlite3"
import fs from "node:fs"
import path from "node:path"

function resolveDataDir() {
  const candidate =
    process.env.DATA_DIR?.trim() ||
    (fs.existsSync("/data") ? "/data/bot-data" : path.join(process.cwd(), "data"))

  try {
    fs.mkdirSync(candidate, { recursive: true })
    fs.accessSync(candidate, fs.constants.W_OK)
    return candidate
  } catch (error) {
    const fallback = path.join(process.cwd(), "data")
    console.error(
      `[SQLite] не удалось использовать ${candidate} (${error.message}), беру ${fallback}`,
    )
    fs.mkdirSync(fallback, { recursive: true })
    return fallback
  }
}

export const DATA_DIR = resolveDataDir()
export const DB_PATH = path.join(DATA_DIR, "bot.sqlite")

export const db = new Database(DB_PATH)

db.pragma("journal_mode = WAL")
db.pragma("foreign_keys = ON")
db.pragma("busy_timeout = 5000")
db.pragma("synchronous = NORMAL")

db.exec(`
  CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_key TEXT NOT NULL UNIQUE,
    chat_type TEXT NOT NULL DEFAULT 'private',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    sender_type TEXT NOT NULL
      CHECK(sender_type IN ('user', 'owner', 'assistant', 'legacy_assistant')),
    message_type TEXT NOT NULL DEFAULT 'text',
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(chat_id) REFERENCES chats(id)
  );

  CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL UNIQUE,
    profile_data TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(chat_id) REFERENCES chats(id)
  );

  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER,
    memory_text TEXT NOT NULL,
    importance INTEGER NOT NULL DEFAULT 1,
    source_message_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(chat_id) REFERENCES chats(id),
    FOREIGN KEY(source_message_id) REFERENCES messages(id)
  );

  CREATE TABLE IF NOT EXISTS summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    summary_text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(chat_id) REFERENCES chats(id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
  CREATE INDEX IF NOT EXISTS idx_memories_chat ON memories(chat_id);
  CREATE INDEX IF NOT EXISTS idx_summaries_chat ON summaries(chat_id);
`)

// --- Запросы -----------------------------------------------------------------

const stmtChatId = db.prepare("SELECT id FROM chats WHERE chat_key = ?")
const stmtInsertChat = db.prepare(
  "INSERT INTO chats (chat_key, chat_type) VALUES (?, ?) ON CONFLICT(chat_key) DO NOTHING",
)
const stmtInsertMessage = db.prepare(
  "INSERT INTO messages (chat_id, sender_type, message_type, content) VALUES (?, ?, ?, ?)",
)
const stmtRecentMessages = db.prepare(`
  SELECT sender_type, content, created_at
  FROM messages
  WHERE chat_id = ?
  ORDER BY id DESC
  LIMIT ?
`)
const stmtLastMessage = db.prepare(`
  SELECT sender_type, content, created_at
  FROM messages
  WHERE chat_id = ?
  ORDER BY id DESC
  LIMIT 1
`)
const stmtCount = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?")

export function ensureChat(chatKey, chatType = "private") {
  stmtInsertChat.run(chatKey, chatType)
  return stmtChatId.get(chatKey).id
}

export function addMessage(chatKey, senderType, content, chatType = "private", messageType = "text") {
  const chatId = ensureChat(chatKey, chatType)
  stmtInsertMessage.run(chatId, senderType, messageType, content)
  return chatId
}

export function lastMessage(chatKey) {
  const chatId = stmtChatId.get(chatKey)?.id
  if (!chatId) return null
  return stmtLastMessage.get(chatId) ?? null
}

// Возвращает последние сообщения в хронологическом порядке.
// Роли для модели: реплики собеседника — user, всё остальное — assistant.
export function recentMessages(chatKey, limit = 12) {
  const chatId = stmtChatId.get(chatKey)?.id
  if (!chatId) return []

  return stmtRecentMessages
    .all(chatId, limit)
    .reverse()
    .map((row) => ({
      role: row.sender_type === "user" ? "user" : "assistant",
      content: row.content,
      senderType: row.sender_type,
      createdAt: row.created_at,
    }))
}

export function deleteChat(chatKey) {
  const chatId = stmtChatId.get(chatKey)?.id
  if (!chatId) return 0
  const changes = db.transaction(() => {
    db.prepare("DELETE FROM messages WHERE chat_id = ?").run(chatId)
    db.prepare("DELETE FROM profiles WHERE chat_id = ?").run(chatId)
    db.prepare("DELETE FROM summaries WHERE chat_id = ?").run(chatId)
    db.prepare("DELETE FROM memories WHERE chat_id = ?").run(chatId)
    db.prepare("DELETE FROM chats WHERE id = ?").run(chatId)
  })()
  return changes
}

export function stats() {
  const chats = db.prepare("SELECT COUNT(*) AS n FROM chats").get().n
  const messages = db.prepare("SELECT COUNT(*) AS n FROM messages").get().n
  return { chats, messages }
}

export function messageCount(chatKey) {
  const chatId = stmtChatId.get(chatKey)?.id
  return chatId ? stmtCount.get(chatId).n : 0
}

// --- Миграция старой истории из conversations.json ---------------------------

const LEGACY_FLAG = "legacy:conversations.json"

function alreadyMigrated() {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(LEGACY_FLAG)
  return Boolean(row)
}

function markMigrated(payload) {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
    LEGACY_FLAG,
    JSON.stringify(payload),
  )
}

db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`)

// Старый формат: { "biz:8826412627": [ {"role":"user"|"assistant","content":"..."} ] }
// В нём роль assistant может означать и ответ ИИ, и реплику владельца.
// Угадать нельзя, поэтому такие сообщения пишем как legacy_assistant.
export function migrateLegacyFile(legacyPath) {
  if (alreadyMigrated()) {
    return { skipped: true, ...stats() }
  }

  if (!fs.existsSync(legacyPath)) {
    markMigrated({ source: legacyPath, note: "файл не найден" })
    return { skipped: true, missing: true, ...stats() }
  }

  const raw = JSON.parse(fs.readFileSync(legacyPath, "utf8"))
  const entries = Object.entries(raw)

  let chatsTouched = 0
  let inserted = 0

  const run = db.transaction(() => {
    for (const [chatKey, messages] of entries) {
      if (!Array.isArray(messages) || messages.length === 0) continue
      const chatType = chatKey.startsWith("biz:") ? "business" : "private"
      const chatId = ensureChat(chatKey, chatType)
      chatsTouched++

      for (const message of messages) {
        const content = String(message?.content ?? "").trim()
        if (!content) continue

        const senderType =
          message.role === "user" ? "user" : "legacy_assistant"

        db.prepare(
          "INSERT INTO messages (chat_id, sender_type, content) VALUES (?, ?, ?)",
        ).run(chatId, senderType, content)
        inserted++
      }
    }
  })

  run()
  markMigrated({ source: legacyPath, chats: chatsTouched, messages: inserted })

  console.log(
    `[SQLite] миграция из ${legacyPath}: ${chatsTouched} чатов, ${inserted} сообщений`,
  )
  return { migrated: true, chats: chatsTouched, messages: inserted, ...stats() }
}

console.log("[SQLite] База данных открыта:", DB_PATH)
export { LEGACY_FLAG }