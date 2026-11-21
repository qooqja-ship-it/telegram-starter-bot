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

После взаимного флирта бот может отправить одно сообщение после паузы,
если последним писал бот или владелец. По умолчанию пауза 12 часов,
проверка раз в 15 минут, тихие часы с 23:00 до 09:00 по Москве.
`NUDGE_AFTER_HOURS=0` отключает функцию. Telegram разрешает отправку только
в течение 24 часов после последнего входящего сообщения. Старому чату
понадобится новое входящее сообщение, чтобы сохранить Business-соединение
и время последнего входящего.

MIT licensed. Built and maintained by FadeHost.

[сертификат](https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt)

