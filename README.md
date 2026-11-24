# Telegram starter bot

[![Deploy to FadeHost](https://fadehost.com/deploy-button.svg)](https://laplace.fadehost.com/register?intent=bot&repo=https://github.com/FadeHost/telegram-starter-bot)

A small Telegram bot to deploy in one click and then make your own: `/start`,
`/help`, `/ping`, `/id`, an inline button and an echo. Node.js and
[grammY](https://grammy.dev). Runs in polling mode by default, so it needs no
web address; switch to webhook mode when you have one.

## Run it on FadeHost

1. In Telegram, talk to [@BotFather](https://t.me/BotFather), send `/newbot`,
   and copy the token.
2. In the FadeHost panel, Apps, Host something, choose Telegram bot and this
   template, paste the token, deploy.
3. Send `/start` to your bot.

The free tier (256 MB) runs it comfortably. Paid tiers add an always-on web
address, which webhook mode can use.

## Run it anywhere else

```bash
npm install
TELEGRAM_BOT_TOKEN=123456789:AAF... npm start
```

## Webhook mode

Telegram pushes updates to your app instead of the app asking. Set:

| Variable | Value |
| --- | --- |
| `TELEGRAM_MODE` | `webhook` |
| `WEBHOOK_URL` | the app's public https address, e.g. `https://my-bot.fadehost.app` |
| `WEBHOOK_SECRET` | any random string (recommended); Telegram sends it with every update and the bot refuses updates without it |
| `PORT` | the port to listen on (set for you on FadeHost) |

Telegram only delivers webhooks to ports 443, 80, 88 and 8443 over https with
a valid certificate. A FadeHost web address on 443 meets that as it is.

## Make it yours

Everything the bot does is in `src/commands.js`. Add a command:

```js
bot.command("weather", (ctx) => ctx.reply("Sunny."))
```

Rules that keep bots healthy: answer callback queries (`ctx.answerCallbackQuery`)
so buttons stop spinning, keep long work off the update handler, and never log
the token.

## Environment

See `.env.example`.

### Романтический режим Telegram Business

`ROMANTIC=1` включает романтический промпт в личных чатах, к которым подключён
бот. Выбери нужные чаты в настройках Telegram Business. Укажи свой
`OWNER_TELEGRAM_ID` и отправь боту `/start` в личке для получения уведомлений
и работы команд управления.

При явном согласии на встречу или прямом предложении встретиться бот
ставит чат на паузу и отправляет владельцу последние реплики. Дальше можно
ответить вручную. Для возобновления автоответов отправь боту
`/on ID_чата`. Текущие чаты доступны через `/chats id`.

Бот может отправить одно сообщение после взаимного флирта или приглашения,
оставшегося без ответа. Последним должен был писать бот или владелец, а в
переписке должен быть естественный повод вернуться к теме. После отказа или
просьбы больше не писать бот пропускает напоминание.
По умолчанию проверка идёт каждую минуту после 12 часов тишины. Обычная
реплика после взаимного флирта сохраняет возможность напомнить о себе.
Тихие часы действуют с 23:00 до 09:00 по Москве. Если к их окончанию
прошло 24 часа с последнего входящего, Telegram уже не разрешит отправку.
`NUDGE_AFTER_HOURS=0` отключает функцию. Интервал между отправленными
напоминаниями в одном чате задаёт `NUDGE_COOLDOWN_HOURS` (по умолчанию 48 часов).
Настройки романтического стиля и сообщения после паузы видны в `/status`.

MIT licensed. Built and maintained by FadeHost.

[сертификат](https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt)

