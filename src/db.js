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

const db = new Database(DB_PATH)
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

  -- Настройки на каждый чат: включён ли бот, с какого сообщения
  -- считать историю. enabled=0 — бот в этом чате молчит.
  -- stage: 0 — обычное общение, 1–3 — этапы знакомства в личных чатах.
  CREATE TABLE IF NOT EXISTS chat_settings (
    chat_id INTEGER PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    reset_after_id INTEGER NOT NULL DEFAULT 0,
    stage INTEGER NOT NULL DEFAULT 0,
    stage_changed_at TEXT,
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

// --- Миграции схемы ------------------------------------------------------------
// CREATE TABLE IF NOT EXISTS не добавляет новые колонки в уже существующую
// таблицу, поэтому колонки, появившиеся позже, добавляем вручную.

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all()
  if (columns.some((c) => c.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  console.log(`[SQLite] добавлена колонка ${table}.${column}`)
}

ensureColumn("chat_settings", "stage", "INTEGER NOT NULL DEFAULT 0")
ensureColumn("chat_settings", "stage_changed_at", "TEXT")
// Когда бот последний раз сам начинал разговор после паузы.
ensureColumn("chat_settings", "nudge_at", "TEXT")

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
  WHERE chat_id = ? AND id > ?
  ORDER BY id DESC
  LIMIT ?
`)
const stmtCount = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?")

// Кеш chat_key -> id. На каждое сообщение раньше уходило 4 лишних запроса:
// INSERT ... ON CONFLICT, затем SELECT того же id, и снова в recentMessages.
// Ключей в базе десятки, память незаметна.
const chatIdCache = new Map()

function chatIdOf(chatKey) {
  const cached = chatIdCache.get(chatKey)
  if (cached !== undefined) return cached

  const row = stmtChatId.get(chatKey)
  if (!row) return null

  chatIdCache.set(chatKey, row.id)
  return row.id
}

function ensureChat(chatKey, chatType = "private") {
  const cached = chatIdCache.get(chatKey)
  if (cached !== undefined) return cached

  stmtInsertChat.run(chatKey, chatType)
  const id = stmtChatId.get(chatKey).id
  chatIdCache.set(chatKey, id)
  return id
}

export function addMessage(chatKey, senderType, content, chatType = "private", messageType = "text") {
  const chatId = ensureChat(chatKey, chatType)
  stmtInsertMessage.run(chatId, senderType, messageType, content)
  return chatId
}

// Возвращает последние сообщения в хронологическом порядке.
// Роли для модели: реплики собеседника — user, всё остальное — assistant.
// Сообщения до точки сброса не отдаём: история начинается с чистого листа,
// но старые данные остаются в базе.
export function recentMessages(chatKey, limit = 12) {
  const chatId = chatIdOf(chatKey)
  if (!chatId) return []

  const { reset_after_id: afterId } = chatSettings(chatKey)

  return stmtRecentMessages
    .all(chatId, afterId, limit)
    .reverse()
    .map((row) => ({
      role: row.sender_type === "user" ? "user" : "assistant",
      content: row.content,
      senderType: row.sender_type,
      createdAt: row.created_at,
    }))
}

// --- Настройки чата ------------------------------------------------------------

const stmtSettings = db.prepare(
  "SELECT enabled, reset_after_id, stage FROM chat_settings WHERE chat_id = ?",
)
const stmtUpsertSettings = db.prepare(`
  INSERT INTO chat_settings (chat_id, enabled, reset_after_id, stage)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(chat_id) DO UPDATE SET
    enabled = excluded.enabled,
    reset_after_id = excluded.reset_after_id,
    stage = excluded.stage,
    updated_at = CURRENT_TIMESTAMP
`)

function chatSettings(chatKey) {
  const chatId = chatIdOf(chatKey)
  if (!chatId) return { enabled: true, reset_after_id: 0, stage: 0 }

  return stmtSettings.get(chatId) ?? { enabled: 1, reset_after_id: 0, stage: 0 }
}

function saveSettings(chatId, { enabled, reset_after_id, stage }) {
  stmtUpsertSettings.run(chatId, enabled ? 1 : 0, reset_after_id, stage)
}

// Включить или выключить бота в одном чате.
export function setChatEnabled(chatKey, enabled, chatType = "private") {
  const chatId = ensureChat(chatKey, chatType)
  const current = stmtSettings.get(chatId) ?? { reset_after_id: 0, stage: 0 }
  saveSettings(chatId, {
    enabled,
    reset_after_id: current.reset_after_id,
    stage: current.stage,
  })
  return enabled
}

export function isChatEnabled(chatKey) {
  return Boolean(chatSettings(chatKey).enabled)
}

// Этап знакомства: 0 — обычное общение, 1 — лёгкий флирт,
// 2 — явный флирт с интригой, 3 — предложение встречи.
// Значение подсказывает модель, но в базу пишется текущее, чтобы
// бот не прыгал между этапами на каждом сообщении.
export function getStage(chatKey) {
  return Number(chatSettings(chatKey).stage) || 0
}

export function setStage(chatKey, stage, chatType = "private") {
  const chatId = ensureChat(chatKey, chatType)
  const current = stmtSettings.get(chatId) ?? { enabled: 1, reset_after_id: 0, stage: 0 }

  saveSettings(chatId, {
    enabled: current.enabled,
    reset_after_id: current.reset_after_id,
    stage,
  })

  if (stage > 0) {
    db.prepare(
      "UPDATE chat_settings SET stage_changed_at = CURRENT_TIMESTAMP WHERE chat_id = ?",
    ).run(chatId)
  }

  return stage
}

// Начать историю заново, не удаляя старые сообщения.
// Модель перестаёт их видеть, в базе они остаются.
export function resetChatHistory(chatKey) {
  const chatId = chatIdOf(chatKey)
  if (!chatId) return { reset: false, kept: 0 }

  const lastId = db
    .prepare("SELECT COALESCE(MAX(id), 0) AS n FROM messages WHERE chat_id = ?")
    .get(chatId).n

  const current = stmtSettings.get(chatId) ?? { enabled: 1, stage: 0 }
  saveSettings(chatId, {
    enabled: current.enabled,
    reset_after_id: lastId,
    stage: current.stage,
  })

  return { reset: true, kept: lastId }
}

export function deleteChat(chatKey) {
  const chatId = chatIdOf(chatKey)
  if (!chatId) return 0
  const changes = db.transaction(() => {
    db.prepare("DELETE FROM messages WHERE chat_id = ?").run(chatId)
    db.prepare("DELETE FROM profiles WHERE chat_id = ?").run(chatId)
    db.prepare("DELETE FROM summaries WHERE chat_id = ?").run(chatId)
    db.prepare("DELETE FROM memories WHERE chat_id = ?").run(chatId)
    db.prepare("DELETE FROM chat_settings WHERE chat_id = ?").run(chatId)
    db.prepare("DELETE FROM chats WHERE id = ?").run(chatId)
  })()
  // Без этого после удаления кеш вернёт id, которого уже нет.
  chatIdCache.delete(chatKey)
  return changes
}

export function stats() {
  const chats = db.prepare("SELECT COUNT(*) AS n FROM chats").get().n
  const messages = db.prepare("SELECT COUNT(*) AS n FROM messages").get().n
  return { chats, messages }
}

export function messageCount(chatKey) {
  const chatId = chatIdOf(chatKey)
  return chatId ? stmtCount.get(chatId).n : 0
}

// Список чатов для команды /chats: ключ, состояние и число сообщений.
export function listChats(limit = 30) {
  return db
    .prepare(`
      SELECT c.chat_key,
             COALESCE(s.enabled, 1) AS enabled,
             (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id) AS messages
      FROM chats c
      LEFT JOIN chat_settings s ON s.chat_id = c.id
      ORDER BY messages DESC
      LIMIT ?
    `)
    .all(limit)
}

// --- Молчащие чаты -------------------------------------------------------------
// Нужны, чтобы бот сам возобновлял разговор после долгой паузы.
// Берём только те чаты, где бот включён и где переписка уже дошла
// до личного этапа: в рабочем чате инициатива неуместна.

const stmtQuietChats = db.prepare(`
  SELECT c.chat_key,
         c.chat_type,
         s.stage,
         m.sender_type AS last_sender,
         m.created_at  AS last_at
  FROM chats c
  JOIN chat_settings s ON s.chat_id = c.id
  JOIN messages m ON m.id = (
    SELECT MAX(id) FROM messages WHERE chat_id = c.id
  )
  WHERE c.chat_type = 'business'
    AND s.enabled = 1
    AND s.stage > 0
    AND m.id > s.reset_after_id
  ORDER BY m.created_at ASC
`)

export function quietChats() {
  return stmtQuietChats.all()
}

// Ключ чата в базе хранится как biz:<id>, наружу отдаём числовой chat id,
// чтобы было куда отправить сообщение.
export function chatIdFromKey(chatKey) {
  const match = /^biz:(\d+)$/.exec(chatKey)
  return match ? Number(match[1]) : null
}

// Когда бот последний раз писал в этот чат. Нужно как защита от повторов:
// даже если собеседник молчит, докучать ему раз в сутки нельзя.
export function lastBotMessageAt(chatKey) {
  const chatId = chatIdOf(chatKey)
  if (!chatId) return null

  const row = db
    .prepare(`
      SELECT created_at FROM messages
      WHERE chat_id = ? AND sender_type = 'assistant'
      ORDER BY id DESC LIMIT 1
    `)
    .get(chatId)

  return row?.created_at ?? null
}

// Отметка «бот сам написал в этот чат», чтобы не писать дважды.
export function markNudge(chatKey, value) {
  const chatId = chatIdOf(chatKey)
  if (!chatId) return
  db.prepare(`
    INSERT INTO chat_settings (chat_id, nudge_at) VALUES (?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET nudge_at = excluded.nudge_at
  `).run(chatId, value)
}

export function nudgeAt(chatKey) {
  const chatId = chatIdOf(chatKey)
  if (!chatId) return null
  const row = db.prepare("SELECT nudge_at FROM chat_settings WHERE chat_id = ?").get(chatId)
  return row?.nudge_at ?? null
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

// Автоматическая миграция при старте: если старая история ещё не перенесена
// и файл найден — переносим. Ошибку глушим, чтобы бот поднялся в любом случае.
export function autoMigrate() {
  const candidates = [
    process.env.LEGACY_JSON?.trim(),
    path.join(process.cwd(), "data", "conversations.json"),
    "/data/conversations.json",
  ].filter(Boolean)

  const legacyPath = candidates.find((candidate) => fs.existsSync(candidate))
  if (!legacyPath) {
    console.log("[SQLite] старая история conversations.json не найдена, миграция не нужна")
    return { skipped: true }
  }

  try {
    return migrateLegacyFile(legacyPath)
  } catch (error) {
    console.error("[SQLite] миграция не удалась:", error.message)
    return { failed: true, error: error.message }
  }
}

console.log("[SQLite] База данных открыта:", DB_PATH)
