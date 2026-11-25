# Everhour + Telegram: a bot that keeps your hours logged (n8n)

An n8n workflow that checks whether your previous working day has hours logged in [Everhour](https://everhour.com), reminds you on Telegram when it does not, and logs the hours for you when you reply with a number. It also gives weekly and monthly reports and reminds you to issue your invoice at the end of the month.

The bot talks Polish and understands Polish replies. The full manual is in the [Polish README](README.md).

## What it does

- Three times a day (9:30, 14:00, 21:30, Europe/Warsaw) it checks yesterday, if that was a working day. It writes only when hours are missing or look wrong (under 6 h or over 10 h).
- You reply with a number and the bot sets your Everhour entry so that the day adds up to it.
- You mark days off with one word or a button, also in advance.
- `/tydzien` and `/raport` show totals taken straight from Everhour reports.
- Before the last working day of the month it reminds you about the invoice and offers the report for that month.

One workflow serves one person: one Everhour API key, one bot, one chat. Everyone runs their own copy.

## Requirements

- n8n with Data tables (n8n Cloud, or self-hosted with a public HTTPS address, which the Telegram Trigger needs).
- An Everhour account and your own API key.
- Telegram.

## Setup

1. Create two Data tables in n8n, with exactly these names and columns:

   | Table | Columns |
   |---|---|
   | `everhour_reminders` | `date` (string), `status` (string), `hours` (number), `pings` (number), `note` (string) |
   | `invoice_reminders` | `period` (string), `status` (string), `pings` (number), `note` (string) |

2. Create two credentials, ideally under these names:
   - `Everhour API key`, type **Header Auth**: Name = `X-Api-Key`, Value = your Everhour API key (bottom of your profile page).
   - `Telegram: Everhour bot`, type **Telegram API**: the token of a new bot from [@BotFather](https://t.me/BotFather).
3. Import [`workflow.json`](workflow.json) into a new workflow.
4. Open the nodes that show a warning and pick the matching credential.
5. Publish the workflow and send `/start` to your bot. It answers with your `chat_id`.
6. Paste the `chat_id` into the **Config** node, field `TELEGRAM_CHAT_ID`, and publish again. From then on the bot answers only in that chat.
7. Send `/status` to check the connection to Everhour.

### Config

| Field | Default | Meaning |
|---|---|---|
| `TELEGRAM_CHAT_ID` | empty | The only chat the bot serves. |
| `MIN_HOURS` / `MAX_HOURS` | 6 / 10 | A daily total outside this range triggers a question. |
| `LOCK_DAYS` | 2 | How many days, counting today, Everhour lets you edit (2 = today and yesterday). |
| `EVERHOUR_TASK_ID` | empty | Task to log on. Empty = the task with the most time in the 14 days before that day. |
| `INVOICE_REMINDERS` | true | `false` turns the invoice reminders off. |

## Usage

| You send | What happens |
|---|---|
| `8`, `7,5`, `7:30`, `7h30` | Total hours for the day. Text after the number becomes the entry comment. |
| `0`, `wolne`, `urlop`, `L4` | Day off: nothing is written to Everhour and the reminders stop. |
| `ok` | Leave the entry as it is and stop reminding. |
| `0 do piątku`, `L4 do 16.10` | Days off from today until the given day, working days only. |
| `wracam` | Cancels the planned days off from today. |
| `/status` | Everhour profile, lock policy, last 7 days, planned days off. |
| `/tydzien` | Hours this week, day by day. |
| `/raport` | Report for the previous month. Another month: `/raport 9` or `/raport 2026-09`. |
| `wystawiona` | Marks the invoice for the month as issued. |

A reply applies to the reminder you answer or whose button you press, otherwise to the newest open reminder. With no open reminder the bot asks: today or yesterday.

## Limitations

- The time zone (`Europe/Warsaw`) and the reminder times are fixed in the workflow.
- Working days are Monday to Friday. The bot does not know public holidays: answer `wolne`.
- The reminder rhythm assumes Everhour locks editing after two days.

## Development

The Code node sources are in [`nodes/`](nodes) and `workflow.json` is generated from them.

```bash
npm install
npm test         # logic tests
npm run build    # builds workflow.json from nodes/*.js
npm run e2e      # end-to-end test on a throwaway n8n (needs Docker and openssl)
```

The end-to-end test imports `workflow.json` into n8n in a container and talks to the bot the way Telegram would, with Everhour and Telegram replaced by a mock on a Docker network that has no internet access. CI runs all of it on every push to `main` and in pull requests.

## License

[MIT](LICENSE)
