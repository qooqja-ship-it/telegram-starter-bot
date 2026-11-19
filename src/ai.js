// Запросы к Lareper API.
//
// Есть два режима: обычный (ждём весь ответ) и потоковый (получаем текст
// по кускам). Потоковый нужен потому, что прокси иногда отвечает 20-30
// секунд, а собеседник всё это время видит пустоту.
//
// Разбор SSE сделан вручную: формат простой, лишняя зависимость не нужна.

class AiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = "AiError"
    this.status = status
  }
}

// Разбирает поток `data: {...}` построчно. Возвращает куски текста.
function parseSseChunk(buffer) {
  const events = []
  let rest = buffer

  for (;;) {
    const split = rest.indexOf("\n\n")
    if (split === -1) break

    const block = rest.slice(0, split)
    rest = rest.slice(split + 2)

    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === "[DONE]") continue

      try {
        const json = JSON.parse(payload)
        const delta = json?.choices?.[0]?.delta
        const text = delta?.content
        if (typeof text === "string" && text) events.push(text)
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

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const { events, rest } = parseSseChunk(buffer)
    buffer = rest

    for (const chunk of events) {
      answer += chunk
      await onDelta?.(chunk, answer)
    }
  }

  return answer.trim()
}
