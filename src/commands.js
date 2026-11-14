
import { InlineKeyboard } from "grammy"

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"
const MODEL = process.env.OPENROUTER_MODEL || "openrouter/free"

const conversations = new Map()
const MAX_HISTORY = 20

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

export function registerCommands(bot) {
  bot.command("start", (ctx) =>
    ctx.reply(
      `Привет, ${ctx.from?.first_name ?? "друг"}! Я ИИ-ассистент. Напиши мне что-нибудь, и мы начнём общаться.`,
      {
        reply_markup: new InlineKeyboard().text("Проверить связь", "ping"),
      },
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
    ctx.reply(
      `Chat ID: ${ctx.chat.id}\nYour ID: ${ctx.from?.id ?? "unknown"}`,
    ),
  )

  bot.command("reset", (ctx) => {
    const key = `${ctx.chat.id}:${ctx.from.id}`
    conversations.delete(key)
    return ctx.reply("Память диалога очищена. Начинаем с чистого листа!")
  })

  bot.callbackQuery("ping", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Pong!" })
  })

  bot.on("message:text", async (ctx) => {
    const apiKey = process.env.OPENROUTER_API_KEY

    if (!apiKey) {
      return ctx.reply("Ошибка: OPENROUTER_API_KEY не настроен в FadeHost.")
    }

    const userText = ctx.message.text.trim()
    if (!userText) return

    const key = `${ctx.chat.id}:${ctx.from.id}`
    const history = conversations.get(key) || []

    history.push({
      role: "user",
      content: userText,
    })

    try {
      await ctx.replyWithChatAction("typing")

      const response = await fetch(OPENROUTER_API_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            {
              role: "system",
              content: SYSTEM_PROMPT,
            },
            ...history.slice(-MAX_HISTORY),
          ],
          temperature: 0.7,
          max_tokens: 1000,
        }),
        signal: AbortSignal.timeout(60000),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(
          data?.error?.message || `OpenRouter HTTP ${response.status}`,
        )
      }

      const answer = data?.choices?.[0]?.message?.content

      const answerText = typeof answer === "string"
        ? answer
        : Array.isArray(answer)
          ? answer.map((part) => part.text || "").join("")
          : ""

      if (!answerText.trim()) {
        throw new Error("Модель вернула пустой ответ.")
      }

      history.push({
        role: "assistant",
        content: answerText,
      })

      conversations.set(key, history.slice(-MAX_HISTORY))

      // Telegram ограничивает длину одного сообщения.
      const chunks = answerText.match(/[\s\S]{1,4000}/g) || []

      for (const chunk of chunks) {
        await ctx.reply(chunk)
      }

    } catch (error) {
      history.pop()

      if (history.length) {
        conversations.set(key, history)
      } else {
        conversations.delete(key)
      }

      console.error("[OpenRouter error]", error.message)

      await ctx.reply(
        "Не удалось получить ответ от ИИ. Попробуй немного позже.\n\n" +
        `Причина: ${error.message.slice(0, 250)}`,
      )
    }
  })
}
