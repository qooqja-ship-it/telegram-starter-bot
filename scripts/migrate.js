// Миграция старой истории из conversations.json в SQLite.
//
// Запускать вручную: npm run migrate
// Повторный запуск ничего не дублирует — факт миграции хранится в таблице meta.
//
// Путь к старому файлу: переменная LEGACY_JSON, по умолчанию data/conversations.json
// рядом с проектом.

import fs from "node:fs"
import path from "node:path"
import { DB_PATH, migrateLegacyFile, stats } from "../src/db.js"

const legacyPath =
  process.env.LEGACY_JSON ||
  [path.join(process.cwd(), "data", "conversations.json"), "/data/conversations.json"].find(
    (candidate) => fs.existsSync(candidate),
  )

if (!legacyPath) {
  console.error("Не нашёл conversations.json. Укажи путь: LEGACY_JSON=/полный/путь npm run migrate")
  process.exit(1)
}

console.log("База:", DB_PATH)
console.log("Старый файл:", legacyPath)

const result = migrateLegacyFile(legacyPath)
console.log(result)
console.log("Итого в базе:", stats())
