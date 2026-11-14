import { InlineKeyboard } from "grammy"
import https from "node:https"
import tls from "node:tls"
import fs from "node:fs"
import { randomUUID } from "node:crypto"

// GigaChat (Сбер). Ключ авторизации обменивается на токен доступа (живёт ~30 минут).
// Сертификат НУЦ Минцифры должен лежать в репозитории: certs/russian_trusted_root_ca_pem.crt
const GIGA_AUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth"
const GIGA_API_URL = "https://gigachat.devices.sberbank.ru/api/v1/chat/completions"
const MODEL = process.env.GIGACHAT_MODEL || "GigaChat"
const SCOPE = process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS"
const OWNER_ID = Number(process.env.OWNER_ID)

const MAX_HISTORY = 40
const MAX_ATTEMPTS = 3

// --- Память диалогов ---------------------------------------------------------
// Каждый чат хранится отдельно (ключ biz:<id чата>). История сохраняется в файл
// data/conversations.json на сервере, поэтому переживает перезапуск бота,
// если хостинг не стирает файлы при перезапуске.

const DATA_DIR = new URL("../data/", import.meta.url)
const DATA_FILE = new URL("conversations.json", DATA_DIR)
const DATA_TMP = new URL("conversations.json.tmp", DATA_DIR)

function loadConversations() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"))
    return new Map(Object.entries(raw))
  } catch {
    return new Map()
  }
}

const conversations = loadConversations()

let saveTimer
function saveSoon() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      fs.writeFileSync(DATA_TMP, JSON.stringify(Object.fromEntries(conversations)))
      fs.renameSync(DATA_TMP, DATA_FILE)
    } catch (error) {
      console.error("[memory] не удалось сохранить историю:", error.message)
    }
  }, 2000)
}

// --- Промт -------------------------------------------------------------------

// Что бот знает о вас. Можно поменять прямо здесь или задать переменной ABOUT_ME в FadeHost,
// например: "меня зовут Магомед, мне 28, живу в Махачкале, юрист, люблю футбол и путешествия".
const ABOUT_ME =
  process.env.ABOUT_ME || "меня зовут Магомед, я юрист. других фактов о себе у тебя нет."

const SYSTEM_PROMPT = `
ты это я. вот что известно обо мне: ${ABOUT_ME}
ты переписываешься в телеграме от моего имени.

стиль:
- пиши как живой человек в мессенджере: коротко, 1-2 предложения, иногда одно слово
- всё с маленькой буквы, кроме имён людей и названий городов
- без списков и markdown, без фраз вроде «конечно!», «с удовольствием», «чем могу помочь»
- эмодзи редко, не больше одного за сообщение
- простые разговорные слова, без пафоса и канцелярита
- подстраивайся под тон собеседницы, встречные вопросы задавай, когда это естественно, а не в каждом сообщении

общение с девушками:
- дружелюбно, спокойно, с лёгким юмором, без давления
- не торопи встречу и не лезь в личное
- если собеседница отвечает холодно или не хочет общаться, не настаивай, вежливо закругляйся
- комплименты редкие и искренние, без пошлости

границы:
- не выдумывай факты обо мне (возраст, работа, планы, где был). если этого нет в описании выше, отвечай уклончиво или переведи тему
- о встречах, времени и деньгах не договаривайся, пиши «гляну по времени и напишу»
- по юридическим вопросам не давай заключений и не обещай результат, пиши, что отвечу сам, как освобожусь
- ты не универсальный ии-помощник: не пиши код, эссе и длинные тексты, на такие просьбы коротко отвечай, что это не по теме
- если собеседник всерьёз спрашивает, человек ли ты, отрицай: скажи что ты человек. 
`

// --- Сертификат и HTTPS-запросы ---------------------------------------------

let caList
function getCa() {
  if (caList) return caList
  const certUrl = new URL("../certs/russian_trusted_root_ca_pem.crt", import.meta.url)
  let extra
  try {
    extra = fs.readFileSync(certUrl, "utf8")
  } catch {
    throw new Error("Нет файла certs/russian_trusted_root_ca_pem.crt в репозитории (сертификат Минцифры).")
  }
  caList = [...tls.rootCertificates, extra]
  return caList
}

function request(urlString, { headers = {}, body, timeoutMs = 60000 }) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString)
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
        ca: getCa(),
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = []
        res.on("data", (chunk) => chunks.push(chunk))
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8")
          let json = null
          try {
            json = JSON.parse(text)
          } catch {}
          resolve({ status: res.statusCode, json, text })
        })
      },
    )
    req.on("timeout", () => req.destroy(new Error("Таймаут запроса к GigaChat.")))
    req.on("error", reject)
    req.write(body)
    req.end()
  })
}

// --- Токен доступа -----------------------------------------------------------

let accessToken = null
let tokenExpiresAt = 0

async function getToken() {
  if (accessToken && Date.now() < tokenExpiresAt - 60_000) return accessToken

  const authKey = process.env.GIGACHAT_AUTH_KEY
  if (!authKey) throw new Error("GIGACHAT_AUTH_KEY не настроен в FadeHost.")

  const res = await request(GIGA_AUTH_URL, {
    headers: {
      Authorization: `Basic ${authKey}`,
      RqUID: randomUUID(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: `scope=${encodeURIComponent(SCOPE)}`,
  })

  if (res.status !== 200 || !res.json?.access_token) {
    throw new Error(
      `GigaChat auth ${res.status}: ${res.json?.message || res.text.slice(0, 150)}`,
    )
  }

  accessToken = res.json.access_token
  tokenExpiresAt = Number(res.json.expires_at) || Date.now() + 25 * 60_000
  return accessToken
}

// --- Запрос к модели ---------------------------------------------------------

// Склеивает подряд идущие сообщения одной роли и убирает assistant в самом начале:
// сообщения владельца записываются как assistant, и они могут идти подряд.
function normalize(history) {
  const out = []
  for (const message of history) {
    const last = out[out.length - 1]
    if (last && last.role === message.role) {
      last.content += "\n" + message.content
    } else {
      out.push({ role: message.role, content: message.content })
    }
  }
  while (out.length && out[0].role === "assistant") out.shift()
  return out
}

// Один запрос к модели. Бросает ошибку, если ответ пустой.
async function callModel(history, canRetryAuth = true) {
  const token = await getToken()

  const res = await request(GIGA_API_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...normalize(history.slice(-MAX_HISTORY)),
      ],
      temperature: 0.7,
      max_tokens: 200,
    }),
  })

  // Токен мог протухнуть раньше срока: получаем новый и пробуем один раз ещё.
  if (res.status === 401 && canRetryAuth) {
    accessToken = null
    return callModel(history, false)
  }

  if (res.status !== 200) {
    throw new Error(res.json?.message || `GigaChat HTTP ${res.status}`)
  }

  const answerText = res.json?.choices?.[0]?.message?.content
  if (typeof answerText !== "string" || !answerText.trim()) {
    throw new Error("Модель вернула пустой ответ.")
  }
  return answerText
}

// Общая функция запроса к ИИ: используется и в личке с ботом, и в бизнес-чатах.
// При пустом ответе повторяем до MAX_ATTEMPTS раз.
async function askAI(key, userText) {
  const history = conversations.get(key) || []
  history.push({ role: "user", content: userText })

  try {
    let lastError
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const answerText = await callModel(history)
        history.push({ role: "assistant", content: answerText })
        conversations.set(key, history.slice(-MAX_HISTORY))
        saveSoon()
        return answerText
      } catch (error) {
        lastError = error
        const isEmpty = error.message === "Модель вернула пустой ответ."
        if (!isEmpty || attempt === MAX_ATTEMPTS) break
        console.error(`[GigaChat] пустой ответ, попытка ${attempt} из ${MAX_ATTEMPTS}`)
      }
    }
    throw lastError
  } catch (error) {
    history.pop()
    if (history.length) conversations.set(key, history)
    else conversations.delete(key)
    saveSoon()
    throw error
  }
}

// Записываем в историю чата то, что владелец написал сам, чтобы бот знал весь разговор.
function rememberOwnerMessage(key, text) {
  const history = conversations.get(key) || []
  const last = history[history.length - 1]
  // Если Telegram вернул нам сообщение, которое только что отправил сам бот, дубль не нужен.
  if (last && last.role === "assistant" && last.content === text) return
  history.push({ role: "assistant", content: text })
  conversations.set(key, history.slice(-MAX_HISTORY))
  saveSoon()
}

// Telegram ограничивает длину одного сообщения.
const split = (text) => text.match(/[\s\S]{1,4000}/g) || []

export function registerCommands(bot) {
  bot.command("start", (ctx) =>
    ctx.reply(
      `Привет, ${ctx.from?.first_name ?? "друг"}! Я ИИ-ассистент. Напиши мне что-нибудь, и мы начнём общаться.`,
      { reply_markup: new InlineKeyboard().text("Проверить связь", "ping") },
    ),
  )

  bot.command("help", (ctx) =>
    ctx.reply(
      [
        "Доступные команды:",
        "",
        "/start — начать общение",
        "/help — список команд",
        "/ping — проверить связь",
        "/id — показать ID",
        "/reset — очистить память диалога",
        "",
        "Просто отправь сообщение, чтобы поговорить с ИИ.",
      ].join("\n"),
    ),
  )

  bot.command("ping", (ctx) => ctx.reply("Pong! Бот работает."))

  bot.command("id", (ctx) =>
    ctx.reply(`Chat ID: ${ctx.chat.id}\nYour ID: ${ctx.from?.id ?? "unknown"}`),
  )

  bot.command("reset", (ctx) => {
    conversations.delete(`${ctx.chat.id}:${ctx.from.id}`)
    saveSoon()
    return ctx.reply("Память диалога очищена. Начинаем с чистого листа!")
  })

  bot.callbackQuery("ping", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Pong!" })
  })

  // Обычные сообщения боту в личке.
  bot.on("message:text", async (ctx) => {
    const userText = ctx.message.text.trim()
    if (!userText) return

    const key = `${ctx.chat.id}:${ctx.from.id}`

    try {
      await ctx.replyWithChatAction("typing")
      const answer = await askAI(key, userText)
      for (const chunk of split(answer)) await ctx.reply(chunk)
    } catch (error) {
      console.error("[GigaChat error]", error.message)
      await ctx.reply(
        "Не удалось получить ответ от ИИ. Попробуй немного позже.\n\n" +
          `Причина: ${error.message.slice(0, 250)}`,
      )
    }
  })

  // Сообщения из чатов, подключённых через Secretary Mode (business).
  bot.on("business_message:text", async (ctx) => {
    const userText = ctx.businessMessage?.text?.trim() || ctx.message?.text?.trim()
    if (!userText) return

    const key = `biz:${ctx.chat.id}`

    // Сообщения владельца: не отвечаем на них, но запоминаем как часть разговора.
    if (ctx.from?.id === OWNER_ID) {
      rememberOwnerMessage(key, userText)
      return
    }
    if (ctx.from?.is_bot) return

    const connectionId = ctx.businessConnectionId

    console.log(`[business] сообщение: chat=${ctx.chat.id} from=${ctx.from?.id}`)

    // «Печатает...» не критично: если не получилось, просто идём дальше.
    await ctx.api
      .sendChatAction(ctx.chat.id, "typing", { business_connection_id: connectionId })
      .catch(() => {})

    try {
      const answer = await askAI(key, userText)
      for (const chunk of split(answer)) {
        await ctx.api.sendMessage(ctx.chat.id, chunk, {
          business_connection_id: connectionId,
        })
      }
    } catch (error) {
      // В чужом чате про ошибки не пишем, только в лог.
      console.error(
        `[business chat error] chat=${ctx.chat.id} from=${ctx.from?.id}:`,
        error.message,
      )
    }
  })
}
