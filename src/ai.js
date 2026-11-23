// Запросы к Lareper API.
//
// Собираем ответ из потока и измеряем время до первого фрагмента текста.
//
// Разбор SSE сделан вручную: формат простой, лишняя зависимость не нужна.

class AiError extends Error {
  constructor(message, status, finishReason) {
    super(message)
    this.name = "AiError"
    this.status = status
    this.finishReason = finishReason
  }
}

// Разбирает события `data: {...}` и сохраняет причину завершения ответа.
function parseSseChunk(buffer) {
  const events = []
  let rest = buffer

  for (;;) {
    const separator = /\r?\n\r?\n/.exec(rest)
    if (!separator) break
    const split = separator.index

    const block = rest.slice(0, split)
    rest = rest.slice(split + separator[0].length)

    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === "[DONE]") continue

      try {
        const json = JSON.parse(payload)
        const choice = json?.choices?.[0]
        if (choice) events.push(choice)
      } catch {
        // Некорректный кусок пропускаем: один битый пакет не должен
        // ронять весь ответ.
      }
    }
  }

  return { events, rest }
}

// Читает поток и отдаёт куски текста через onDelta.
export async function streamModel({
  baseUrl,
  apiKey,
  model,
  body,
  signal,
  onDelta,
  reasoningEffort,
}) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      ...body,
      model,
      stream: true,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    }),
    signal,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new AiError(`${model}: HTTP ${response.status}: ${text.slice(0, 250)}`, response.status)
  }

  if (!response.body) {
    throw new AiError(`${model}: сервер не вернул поток.`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let answer = ""

  async function append(events) {
    for (const choice of events) {
      if (["length", "content_filter"].includes(choice.finish_reason)) {
        throw new AiError(`${model}: API не завершил ответ (${choice.finish_reason}).`, undefined, choice.finish_reason)
      }
      const chunk = choice.delta?.content
      if (typeof chunk !== "string" || !chunk) continue
      answer += chunk
      await onDelta?.(chunk, answer)
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const { events, rest } = parseSseChunk(buffer)
      buffer = rest

      await append(events)
    }

    const tail = parseSseChunk(buffer + decoder.decode() + "\n\n")
    await append(tail.events)
    return answer.trim()
  } finally {
    await reader.cancel().catch(() => {})
  }
}
