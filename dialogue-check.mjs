import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath, pathToFileURL } from "node:url"

const testDir = path.dirname(fileURLToPath(import.meta.url))
const root = process.argv[2] ? path.resolve(process.argv[2]) : testDir
const unix = (time) => Date.parse(time) / 1000
const reply = (text, finish = "stop") => new Response(
  'data: ' + JSON.stringify({choices: [{delta: {content: text}}]}) + '\n\n' +
  'data: ' + JSON.stringify({choices: [{delta: {}, finish_reason: finish}]}) + '\n\ndata: [DONE]\n\n',
)
function testEqual(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected))
}
export async function boot(romantic = true, transport, model, botRoot = root, extraEnv = {}) {
  const database = new DatabaseSync(":memory:")
  class DatabaseAdapter {
    constructor() { return database }
  }
  database.pragma = (s) => database.exec("PRAGMA " + s)
  const events = new Map()
  const commands = new Map()
  const timers = new Map()
  const intervals = new Map()
  const sent = []
  const requests = []
  const scripts = []
  const logs = []
  let now = Date.parse("2026-11-23T08:00:00Z")
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])) }
    static now() { return now }
  }
  const api = {
    sendMessage: async (id, text, options) => sent.push({ id, text, options }),
    getBusinessConnection: async () => ({ is_enabled: true, rights: { can_reply: true }, user: { id: 1 } }),
    sendChatAction: async () => {},
  }
  const timer = (group) => (fn, delay) => {
    const handle = { unref() {} }
    group.set(handle, { fn, delay })
    return handle
  }
  const context = vm.createContext({
    process: { env: { ROMANTIC: romantic ? "1" : "0", NUDGE_AFTER_HOURS: "12", LAREPER_API_KEY: "fake",
      LAREPER_PRIMARY_MODEL: model ?? "primary", LAREPER_FALLBACK_MODEL: model ?? "backup", DATA_DIR: testDir, OWNER_TELEGRAM_ID: "1",
      ...extraEnv } },
    Date: FakeDate, URL, TextDecoder, AbortController,
    console: { log: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    setTimeout: timer(timers), clearTimeout: (handle) => timers.delete(handle),
    setInterval: timer(intervals), clearInterval: (handle) => intervals.delete(handle),
    fetch: async (_url, request) => {
      const body = JSON.parse(request.body)
      requests.push(body)
      if (transport) return transport(body)
      assert.ok(scripts.length, "unscripted model request")
      return scripts.shift()(body, request.signal)
    },
  })
  const external = new Map([["node:fs", fs], ["node:path", path], ["grammy", null], ["better-sqlite3", DatabaseAdapter]])
  const modules = new Map()
  function load(name) {
    if (modules.has(name)) return modules.get(name)
    let module
    if (external.has(name)) {
      const key = name === "grammy" ? "InlineKeyboard" : "default"
      module = new vm.SyntheticModule([key], function () { this.setExport(key, external.get(name)) }, { context })
    } else {
      const file = path.join(botRoot, name)
      module = new vm.SourceTextModule(fs.readFileSync(file, "utf8"), {
        context, identifier: name, initializeImportMeta: (meta) => { meta.url = pathToFileURL(file).href },
      })
    }
    modules.set(name, module)
    return module
  }
  const entry = load("src/commands.js")
  await entry.link((specifier, parent) => load(external.has(specifier) ? specifier :
    path.posix.join(path.posix.dirname(parent.identifier), specifier)))
  await entry.evaluate()
  entry.namespace.registerCommands({ api, command: (n, f) => commands.set(n, f), callbackQuery() {},
    on: (event, f) => events.set(event, f) })
  const db = modules.get("src/db.js").namespace
  const key = "biz:7"
  const user = (text, fromId = 7, chatId = 7) => events.get("business_message")({
    businessMessage: { chat: { id: chatId, type: "private" }, business_connection_id: "c", date: now / 1000, text },
    from: { id: fromId, first_name: fromId === 7 ? "Аня" : "Магомед" },
    getBusinessConnection: () => api.getBusinessConnection(), api,
  })
  const fire = (delay) => {
    const next = [...timers].find(([, value]) => value.delay === delay)
    assert.ok(next, "timer missing: " + delay)
    timers.delete(next[0])
    return next[1].fn()
  }
  return {
    database, db, key, user, sent, requests, scripts, logs, timers, intervals, commands, fire,
    run: () => fire(1500),
    nudge: () => [...intervals.values()].find((t) => t.delay === 60_000).fn(),
    move: (time) => { now = Date.parse(time) },
    sqliteTime: (id, at) => database.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(at, id),
  }
}

const scenarios = []
function scenario(name, run) { scenarios.push([name, run]) }
scenario("first playful step with a plain reply and preserved owner / bot / legacy attribution", async () => {
  const t = await boot()
  t.db.addMessage(t.key, "legacy_assistant", "старое сообщение", "business")
  t.db.addMessage(t.key, "owner", "давай ещё раунд", "business")
  t.db.addMessage(t.key, "assistant", "счёт уже один ноль)", "business")
  await t.user("выиграла второй раз, всё ещё думаешь, что повезло?")
  t.scripts.push((body) => {
    assert.match(body.messages[0].content, /сделай первый шаг сам/u)
    testEqual(JSON.parse(body.messages[1].content), [
      { author: "старый исходящий", text: "старое сообщение" },
      { author: "владелец", text: "давай ещё раунд" },
      { author: "бот", text: "счёт уже один ноль)" },
      { author: "собеседник", text: "выиграла второй раз, всё ещё думаешь, что повезло?" },
    ])
    return reply("второй раз — это уже закономерность)")
  })
  await t.run()
  assert.equal(t.sent[0].text, "второй раз - это уже закономерность)")
  assert.equal(t.db.recentMessages(t.key).at(-1).content, t.sent[0].text)
  assert.equal(t.db.getStage(t.key), 1)
})
scenario("message burst keeps the correction and does not assume romantic interest", async () => {
  const t = await boot()
  await t.user("завтра выходной")
  await t.user("точнее, завтра опять на смену")
  await t.user("и сегодня уже вымоталась")
  assert.equal(t.timers.size, 1)
  t.scripts.push((body) => {
    assert.match(body.messages[0].content, /новая информация важнее/u)
    testEqual(JSON.parse(body.messages[1].content).map((m) => m.text),
      ["завтра выходной", "точнее, завтра опять на смену", "и сегодня уже вымоталась"])
    return reply("после такого дня ещё и смена завтра. тяжело звучит")
  })
  await t.run()
  assert.equal(t.requests.length, 1)
  assert.equal(t.sent.length, 1)
})
scenario("acceptance references an older manual invite and hands the chat to the owner", async () => {
  const t = await boot()
  t.db.addMessage(t.key, "owner", "давай кофе на неделе?", "business")
  for (let i = 1; i <= 15; i++) t.db.addMessage(t.key, "user", "реплика " + i, "business")
  await t.user("про кофе, давай)")
  t.scripts.push((body) => {
    const transcript = JSON.parse(body.messages[1].content)
    testEqual(transcript[0], { author: "владелец", text: "давай кофе на неделе?" })
    assert.equal(transcript.at(-1).text, "про кофе, давай)")
    return reply("[[action:accepted]]")
  })
  await t.run()
  assert.equal(t.sent[0].id, 1)
  assert.equal(t.db.isChatEnabled(t.key), false)
})
scenario("declined invitation blocks a repeated invite and uses a normal fallback", async () => {
  const t = await boot()
  t.db.setStage(t.key, 3, "business")
  await t.user("нет, не хочу встречаться")
  t.scripts.push(() => reply("понял) [[action:declined]]"))
  await t.run()
  assert.equal(t.sent[0].text, "понял)")
  assert.equal(t.db.getStage(t.key), 4)
  await t.user("но за второй раунд я всё ещё за")
  t.scripts.push(() => reply("давай тогда кофе? [[action:invite]]"),
    () => reply("второй раунд. на этот раз хотя бы не поддавайся)"))
  await t.run()
  testEqual(t.requests.map((r) => r.model), ["primary", "primary", "backup"])
  assert.equal(t.sent.at(-1).text, "второй раунд. на этот раз хотя бы не поддавайся)")
})
scenario("an initiated meeting marks the invitation and does not confuse an unrelated yes for acceptance", async () => {
  const t = await boot()
  t.db.setStage(t.key, 2, "business")
  await t.user("за кофе со мной ты точно потеряешь счёт времени)")
  t.scripts.push(() => reply("тогда давай проверим за кофе. часы можно не брать)\n[[action:invite]]"))
  await t.run()
  assert.equal(t.db.getStage(t.key), 3)
  assert.equal(t.sent[0].text, "тогда давай проверим за кофе. часы можно не брать)")
  await t.user("кстати, ты про тот фильм с поездом?")
  t.scripts.push(() => reply("про него. ты его уже смотрела?"))
  await t.run()
  await t.user("да)")
  t.scripts.push((body) => {
    assert.match(body.messages[0].content, /«да» на посторонний вопрос не подтверждают встречу/u)
    assert.equal(JSON.parse(body.messages[1].content).at(-2).text, "про него. ты его уже смотрела?")
    return reply("тогда можно обсуждать концовку без спойлеров)")
  })
  await t.run()
  assert.equal(t.db.isChatEnabled(t.key), true)
  assert.equal(t.sent.at(-1).id, 7)
})
scenario("a false invite marker does not register a solo plan, reassurance or online activity", async () => {
  const t = await boot()
  for (const text of ["надо будет как-нибудь проверить самому)", "отдыхай, набирайся сил", "давай пока не будем встречаться", "потанцуем онлайн?"]) {
    await t.user("я туда иногда захожу, у них хороший капучино")
    t.scripts.push(() => reply(text + "\n[[action:invite]]"))
    await t.run()
    assert.equal(t.sent.at(-1).text, text)
    assert.notEqual(t.db.getStage(t.key), 3)
  }
})
scenario("wrong voice falls back and an explicit unmarked invitation is registered", async () => {
  const t = await boot()
  await t.user("я туда иногда захожу, у них хороший капучино")
  t.scripts.push(
    () => reply("надо будет как-нибудь проверить самой\n[[action:invite]]"),
    () => reply("сходим туда за капучино вдвоём?"),
  )
  await t.run()
  testEqual(t.requests.map((r) => r.model), ["primary", "backup"])
  testEqual(t.sent.map((r) => r.text), ["сходим туда за капучино вдвоём?"])
  assert.equal(t.db.getStage(t.key), 3)
})
scenario("404 and truncated SSE both use the backup without leaking partial text", async () => {
  const t = await boot()
  await t.user("у тебя осталась одна попытка угадать)")
  t.scripts.push(() => new Response("model unavailable", { status: 404 }), () => reply("оставлю её на десерт)"))
  await t.run()
  await t.user("вот теперь мне интересно")
  t.scripts.push(() => reply("тогда у меня", "length"), () => reply("так и задумано)"))
  await t.run()
  testEqual(t.requests.map((r) => r.model), ["primary", "backup", "primary", "backup"])
  testEqual(t.sent.map((r) => r.text), ["оставлю её на десерт)", "так и задумано)"])
})
scenario("DeepSeek retries an output limit once and delivers only the complete invitation", async () => {
  const t = await boot(true, undefined, "deepseek-v4.1-flash")
  await t.user("я туда иногда захожу, у них хороший капучино")
  t.scripts.push(() => {
    t.move("2026-11-23T08:00:08Z")
    return reply("давай", "length")
  }, () => {
    assert.ok([...t.timers.values()].some((timer) => timer.delay === 12_000))
    return reply("выпьем там кофе вдвоём?\n[[action:invite]]")
  })
  await t.run()
  testEqual(t.requests.map((r) => r.max_tokens), [1024, 2048])
  testEqual(t.sent.map((r) => r.text), ["выпьем там кофе вдвоём?"])
  assert.equal(t.db.getStage(t.key), 3)
})
scenario("two truncated DeepSeek streams end without a third request or a partial reply", async () => {
  const t = await boot(true, undefined, "deepseek-v4.1-flash")
  await t.user("тебе бы пришлось держаться за меня)")
  t.scripts.push(() => reply("", "length"), () => reply("тогда", "length"))
  await t.run()
  assert.equal(t.requests.length, 2)
  assert.equal(t.sent.length, 0)
})
scenario("three Business models receive 20 seconds each within the 60-second budget", async () => {
  const t = await boot(true, undefined, undefined, root, { LAREPER_THIRD_MODEL: "third" })
  await t.user("ну что, догадался?")
  const untilTimeout = (_body, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  })
  t.scripts.push(untilTimeout, untilTimeout, untilTimeout)
  const pending = t.run()
  for (let seconds = 20; seconds <= 60; seconds += 20) {
    t.move(new Date(Date.UTC(2026, 10, 23, 8, 0, seconds)).toISOString())
    t.fire(20_000)
    await new Promise((resolve) => setImmediate(resolve))
  }
  await pending
  testEqual(t.requests.map((r) => r.model), ["primary", "backup", "third"])
  assert.equal(t.sent.length, 0)
})
scenario("manual reply cancels an in-flight generation without sending or falling back", async () => {
  const t = await boot()
  let aborted = false
  await t.user("ты уже решил?")
  t.scripts.push((_body, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason) }, { once: true })
  }))
  const pending = t.run()
  await t.user("да, уже разобрался", 1)
  await pending
  assert.ok(aborted)
  assert.equal(t.requests.length, 1)
  assert.equal(t.sent.length, 0)
  assert.equal(t.timers.size, 0)
})
scenario("mutual flirting survives an ordinary exchange and sends one nudge at 12 hours", async () => {
  const t = await boot()
  t.move("2026-11-23T05:30:00Z")
  await t.user("мне уже нравится, как ты проигрываешь)")
  t.scripts.push(() => reply("я ещё и приз не узнал, а уже готов проиграть снова) [[action:flirt]]"))
  await t.run()
  assert.equal(t.db.getStage(t.key), 2)
  await t.user("кстати, спор был про корицу в кофе")
  t.scripts.push(() => reply("теперь понятно, почему такой горячий спор)"))
  await t.run()
  assert.equal(t.db.getStage(t.key), 2)
  t.sqliteTime(t.db.lastMessageId(t.key), "2026-11-23 05:30:00")
  t.move("2026-11-23T17:29:00Z")
  await t.nudge()
  assert.equal(t.sent.length, 2)
  t.move("2026-11-23T17:30:00Z")
  t.scripts.push((body) => {
    assert.match(body.messages[0].content, /после паузы/u)
    assert.equal(JSON.parse(body.messages[1].content).at(-1).author, "бот")
    return reply("так корицу в кофе ты в итоге защищаешь или обвиняешь?)")
  })
  await t.nudge()
  assert.equal(t.sent.length, 3)
  assert.match(t.sent[2].text, /корицу/u)
  await t.nudge()
  assert.equal(t.sent.length, 3)
})
scenario("explicit request to tone down cancels eligibility for the nudge", async () => {
  const t = await boot()
  t.db.setStage(t.key, 2, "business")
  t.move("2026-11-23T05:00:00Z")
  await t.user("давай без флирта, мне некомфортно")
  t.scripts.push(() => reply("понял тебя\n[[action:cooldown]]"))
  await t.run()
  assert.equal(t.db.getStage(t.key), 1)
  t.sqliteTime(t.db.lastMessageId(t.key), "2026-11-23 05:00:00")
  t.move("2026-11-23T18:00:00Z")
  await t.nudge()
  assert.equal(t.requests.length, 1)
})
async function inviteAfterCoffee(t) {
  t.move("2026-11-23T05:30:00Z")
  await t.user("у них хороший капучино")
  t.scripts.push(() => reply("выпьем там кофе вдвоём?\n[[action:invite]]"))
  await t.run()
  assert.equal(t.db.getStage(t.key), 3)
  t.sqliteTime(t.db.lastMessageId(t.key), "2026-11-23 05:30:00")
}
scenario("an unanswered invitation gets one neutral message after 12 hours", async () => {
  const t = await boot()
  await inviteAfterCoffee(t)
  t.move("2026-11-23T17:29:00Z")
  await t.nudge()
  assert.equal(t.sent.length, 1)
  t.move("2026-11-23T17:30:00Z")
  t.scripts.push((body) => {
    assert.match(body.messages[0].content, /Последнее приглашение осталось без ответа/u)
    return reply("пойдём за кофе?")
  }, () => reply("капучино – понятно. а десерты там как?"))
  await t.nudge()
  assert.equal(t.sent.at(-1).text, "капучино - понятно. а десерты там как?")
  assert.equal(t.db.getStage(t.key), 3)
  t.move("2026-11-23T18:00:00Z")
  await t.nudge()
  assert.equal(t.sent.length, 2)
  assert.equal(t.requests.length, 3)
})
scenario("an old untyped invitation remains eligible outside the model's 30-message history", async () => {
  const t = await boot()
  t.move("2026-11-23T05:30:00Z")
  t.db.setStage(t.key, 3, "business")
  t.db.rememberBusinessIncoming(t.key, "c", unix("2026-11-23T05:30:00Z"))
  t.db.addMessage(t.key, "user", "у них хороший капучино", "business")
  t.db.addMessage(t.key, "assistant", "выпьем там кофе вдвоём?", "business")
  for (let i = 0; i < 30; i++) t.db.addMessage(t.key, "owner", "реплика " + i, "business")
  t.sqliteTime(t.db.lastMessageId(t.key), "2026-11-23 05:30:00")
  t.move("2026-11-23T17:30:00Z")
  t.scripts.push((body) => {
    assert.match(body.messages[0].content, /Последнее приглашение осталось без ответа/u)
    assert.equal(JSON.parse(body.messages[1].content).some(({ text }) => text.includes("кофе")), false)
    return reply("теперь интересно, чем закончилась та история)")
  })
  await t.nudge()
  assert.equal(t.sent.length, 1)
})

scenario("the owner can see why a nudge was skipped without triggering a send", async () => {
  const t = await boot()
  const status = (from = 1) => t.commands.get("nudge_status")({
    from: { id: from },
    message: { text: "/nudge_status 7" },
    reply: (text) => text,
  })
  assert.match(await status(2), /только для владельца/u)
  assert.match(await status(), /не найден/u)
  await inviteAfterCoffee(t)
  assert.equal(t.db.unansweredBotReplies(t.key)[0].message_type, "invite")
  assert.match(await status(), /примерно 720 мин/u)
  t.move("2026-11-23T17:30:00Z")
  t.scripts.push(() => reply("[[skip]]"))
  await t.nudge()
  assert.match(await status(), /Модель пропустила напоминание/u)
  assert.equal(t.requests.length, 2)
  assert.equal(t.sent.length, 1)
  assert.ok(t.logs.some(([line]) => /модель пропустила напоминание/u.test(line)))
})
for (const [description, incoming, modelReply, stage] of [
  ["declined", "нет, не хочу встречаться", "понял, оставим эту тему\n[[action:declined]]", 4],
  ["answered without the declined marker", "нет, не хочу встречаться", "понял тебя", 3],
  ["asked for no further messages", "пожалуйста, не пиши мне", null, 3],
]) {
  scenario("an invitation gets no nudge when the recipient has " + description, async () => {
    const t = await boot()
    await inviteAfterCoffee(t)
    await t.user(incoming)
    if (modelReply) {
      t.scripts.push(() => reply(modelReply))
      await t.run()
      t.sqliteTime(t.db.lastMessageId(t.key), "2026-11-23 05:30:00")
    } else {
      assert.equal(t.db.isChatEnabled(t.key), false)
    }
    assert.equal(t.db.getStage(t.key), stage)
    const requests = t.requests.length
    t.move("2026-11-23T17:30:00Z")
    await t.nudge()
    assert.equal(t.requests.length, requests)
  })
}
scenario("explicit stop disables autoresponses without contacting the model", async () => {
  const t = await boot()
  t.db.setStage(t.key, 2, "business")
  await t.user("пожалуйста, больше не пиши мне")
  assert.equal(t.db.isChatEnabled(t.key), false)
  assert.equal(t.timers.size, 0)
  assert.equal(t.requests.length, 0)
})
async function eligibleChat(t, incomingAt, outgoingAt) {
  t.db.setStage(t.key, 2, "business")
  t.db.addMessage(t.key, "user", "про кофе смешно получилось)", "business")
  t.db.rememberBusinessIncoming(t.key, "c", unix(incomingAt))
  t.db.addMessage(t.key, "owner", "ещё бы)", "business")
  t.sqliteTime(t.db.lastMessageId(t.key), outgoingAt)
}
scenario("night defers a due nudge until morning inside the reply window", async () => {
  const t = await boot()
  await eligibleChat(t, "2026-11-23T11:30:00Z", "2026-11-23 12:00:00")
  t.move("2026-11-24T00:00:00Z")
  await t.nudge()
  assert.equal(t.requests.length, 0)
  t.move("2026-11-24T06:00:00Z")
  t.scripts.push(() => reply("так что в итоге было смешнее, сам кофе или спор о нём?)"))
  await t.nudge()
  assert.equal(t.sent.length, 1)
})
scenario("reply window expiry and model skip leave the chat alone", async () => {
  const t = await boot()
  await eligibleChat(t, "2026-11-23T05:30:00Z", "2026-11-23 16:30:00")
  t.move("2026-11-24T06:00:00Z")
  await t.nudge()
  assert.equal(t.requests.length, 0)
  t.db.rememberBusinessIncoming(t.key, "c", unix("2026-11-23T16:00:00Z"))
  t.scripts.push(() => reply("[[skip]]"))
  await t.nudge()
  t.move("2026-11-24T06:01:00Z")
  await t.nudge()
  assert.equal(t.requests.length, 1)
  assert.equal(t.sent.length, 0)
})
scenario("disabled romantic mode keeps Business neutral and does not schedule a nudge", async () => {
  const t = await boot(false)
  assert.equal(t.intervals.size, 0)
  await t.user("сегодня пришлось задержаться на работе")
  t.scripts.push((body) => {
    assert.doesNotMatch(body.messages[0].content, /сделай первый шаг сам/u)
    return reply("день и так длинный, а тут ещё и задержка")
  })
  await t.run()
  assert.equal(t.sent.length, 1)
})

if (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [name, run] of scenarios) {
    await run()
    console.log("PASS " + name)
  }
  console.log(scenarios.length + " scenarios passed")
}

