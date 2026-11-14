import { InlineKeyboard } from "grammy"

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"
const MODEL = process.env.OPENROUTER_MODEL || "openrouter/free"
const OWNER_ID = Number(process.env.OWNER_ID)

const conversations = new Map()
const MAX_HISTORY = 20
const MAX_ATTEMPTS = 3

const SYSTEM_PROMPT = `
Ты русскоязычный ИИ-ассистент в Telegram.
Твоя задача — помогать пользователю, отвечать на вопросы,
объяснять сложные вещи простым языком и поддерживать диалог.

Правила:
- Отвечай преимущественно на русском языке.
- Будь грамотным, дружелюбным и естественным.
- Не выдумывай факты и признавай, если чего-то не знаешь.
- Учитывай контекст предыдущих сообщений.
- Используй структурированные ответы, когда это полезно.
- Не повторяй вопрос пользователя без необходимости.
`

// Один запрос к модели. Бросает ошибку, если ответ пустой.
async function callModel(apiKey, history) {
  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...history.slice(-MAX_HISTORY),
      ],
      temperature: 0.7,
      max_tokens: 1000,
    }),
    signal: AbortSignal.timeout(60000),
  })

  const data = await response.json()

  if (!response.ok) {
    throw new Error(data?.error?.message || `OpenRouter HTTP ${response.status}`)
  }

  const answer = data?.choices?.[0]?.message?.content
  const answerText =
    typeof answer === "string"
      ? answer
      : Array.isArray(answer)
        ? answer.map((part) => part.text || "").join("")
        : ""

  if (!answerText.trim()) throw new Error("Модель вернула пустой ответ.")
  return answerText
}

// Общая функция запроса к ИИ: используется и в личке с ботом, и в бизнес-чатах.
// Бесплатные модели иногда отвечают пустотой, поэтому повторяем до MAX_ATTEMPTS раз.
async function askAI(key, userText) {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error("OPENROUTER_API_KEY не настроен в FadeHost.")

  const history = conversations.get(key) || []
  history.push({ role: "user", content: userText })

  try {
    let lastError
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const answerText = await callModel(apiKey, history)
        history.push({ role: "assistant", content: answerText })
        conversations.set(key, history.slice(-MAX_HISTORY))
        return answerText
      } catch (error) {
        lastError = error
        const isEmpty = error.message === "Модель вернула пустой ответ."
        if (!isEmpty || attempt === MAX_ATTEMPTS) break
        console.error(`[OpenRouter] пустой ответ, попытка ${attempt} из ${MAX_ATTEMPTS}`)
      }
    }
    throw lastError
  } catch (error) {
    history.pop()
    if (history.length) conversations.set(key, history)
    else conversations.delete(key)
    throw error
  }
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
      console.error("[OpenRouter error]", error.message)
      await ctx.reply(
        "Не удалось получить ответ от ИИ. Попробуй немного позже.\n\n" +
          `Причина: ${error.message.slice(0, 250)}`,
      )
    }
  })

  // Сообщения из чатов, подключённых через Secretary Mode (business).
  bot.on("business_message:text", async (ctx) => {
    // Свои же сообщения владельца тоже приходят сюда: на них не отвечаем.
    if (ctx.from?.id === OWNER_ID) return
    if (ctx.from?.is_bot) return

    const userText = ctx.businessMessage?.text?.trim() || ctx.message?.text?.trim()
    if (!userText) return

    const connectionId = ctx.businessConnectionId
    const key = `biz:${ctx.chat.id}`

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
