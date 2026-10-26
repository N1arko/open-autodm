<div align="center">

<img src="public/logo.svg" width="90" alt="open-autoDM logo" />

# open-autoDM

**Open-source, self-hosted Instagram messaging, Reels, carousels, Stories, Insights and Meta advertising.**

Connect external bots, publish scheduled Reels, carousels and Stories, read account and advertising metrics,
and manage campaigns through an owner HTTP API. The service also includes the original
keyword and comment-to-DM automation. Meta supplies the official platform APIs;
external bots own their LLM calls and conversation history.

`Next.js app` · `Persistent worker` · `Supabase (DB + auth + queues)`

**⭐ Star this repo now** - it takes 2 seconds, helps other creators find a free alternative to
$25/month tools, and new features land here regularly. **Watch** the repo to catch them.

> 🛠️ **Don't want to set it up yourself?** I'll deploy the whole system on your own accounts -
> running at near-zero server cost - for a minimal one-time setup charge, for all your Instagram
> accounts. DM me on Instagram: [**@buildwharsha**](https://www.instagram.com/buildwharsha/) 🙂

</div>

---

## Работа с этим форком

Этот репозиторий `N1arko/open-autodm` содержит один сервис: Instagram Direct с внешними ботами, публикацию Reels, Instagram Insights и управление рекламой Meta. Для управления через ИИ-агента есть HTTP API владельца. Next.js приложение и постоянный worker используют общий Supabase.

**Новому чату:** начните с [AGENTS.md](AGENTS.md) и [карты проекта](docs/PROJECT_GUIDE.md). Локальное расположение доступа задаётся в исключённом из Git `.local/AGENT_ACCESS.md`. Состав подключённых аккаунтов, разрешения и состояние заданий проверяются через API.

| Возможность | Документация |
| --- | --- |
| Управление без входа в панель | [API владельца](docs/AGENT_API.md) |
| Любые внешние обработчики Direct | [API ботов](docs/BOT_API.md) |
| Reels, видео-карусели, Stories, расписание и обложки | [Публикации](docs/PUBLISHING_API.md) |
| Статистика Instagram и наблюдения | [Insights](docs/INSIGHTS_API.md) |
| Рекламные кабинеты и отчёты | [Чтение рекламы](docs/ADS_API.md) |
| Рекламные подписки, посещения профиля, стоимость и дневная динамика | [Результаты рекламы](docs/ADS_REPORTING_API.md) |
| Кампании, объявления, бюджеты и targeting | [Управление рекламой](docs/ADS_MANAGEMENT_API.md) |
| География/search, локальные картинки, Direct-шаблоны, carousel и настройки creative | [Рекламные материалы](docs/ADS_CREATIVE_API.md) |
| Пиксели, аудитории, каталоги, фоновые правила и проверка токенов | [Рекламные ресурсы](docs/ADS_AUTOMATION_API.md) |
| Приложение, worker, окружение и миграции | [Развёртывание](docs/DEPLOYMENT.md) |

Разделы ниже описывают исходные automation и варианты установки community-проекта. Для модулей этого форка используйте контракты выше; для VPS — инструкцию развёртывания. Логику LLM, prompts и историю диалогов задаёт внешний бот.

## ✨ What it does

- **Comment → DM** - auto-DM anyone who comments a trigger keyword (or any comment) on a specific post or all posts. Sent as Meta **Private Replies** - the purpose-built comment-to-DM channel with its own 750/hour allowance, valid up to 7 days after the comment.
- **DM keyword auto-replies** - someone DMs you `DIET` → they instantly get the resource you attached to that keyword.
- **Story reply triggers** - someone replies `DIET` to your story → same thing. Story replies route to their own automations, separate from plain DMs.
- **Tappable link buttons** - links are delivered as real button-template DMs (a button that opens the URL), with automatic fallback to an inline link if Meta rejects the template for a recipient.
- **Public comment replies** - replies to the trigger comment with a random line from your list ("Sent! Check your DMs 📬"). Idempotent - a retried job never double-posts.
- **2-step button flow** - opening DM with a *"Send me the link"* button; content is delivered only after the tap (massively better delivery + engagement).
- **Ask-to-follow gate** - optionally ask people to follow you before delivering the content (Visit Profile + "I'm following ✅" buttons).
- **Text + card responses** - plain messages, link buttons, or rich cards with image / subtitle / up to 3 URL buttons.
- **`{username}` personalization** - greet commenters by their @handle in messages and public replies.
- **Multiple Instagram accounts** - connect as many professional accounts as you like and switch between them in the sidebar; automations, contacts, and analytics are scoped per account.
- **Analytics** - conversion funnel (trigger → delivered → button tap → follow gained), daily trigger/delivery/contact charts, and per-automation breakdowns, filterable by automation and time range.
- **Live debug panel** - watch every webhook → match → send step stream in real time while testing.

## 🛡️ Built to keep your Instagram account safe

This isn't a scraper or a browser bot - it uses the **official Instagram API** end-to-end, and the architecture enforces every platform rule:

| Rule | How it's enforced |
|---|---|
| 200 DMs/hour per account (Meta hard limit) | Atomic Postgres rate limiter capped at **180/hour** (rolling window, 20-DM safety buffer for your manual DMs) |
| 24-hour messaging window | Checked at webhook receipt **and** again before every send |
| One DM per person per trigger | `UNIQUE` constraints at the database level - duplicates are physically impossible |
| No bot-like bursts | Randomized 2-5s delay before every flow, 1-2.5s between consecutive messages; sends are sequential, never parallel |
| Response bursts | Hard cap of 5 messages per flow (enforced server-side), and every message counts against the hourly window - not just the first |
| Policy blocks (Meta error 368) | **Circuit breaker**: all sends for the account auto-pause for 24h instead of retrying into a ban |
| Meta-side rate limit errors (4/17/32/613) | Generous 15-minute backoff, no attempt burned |
| Webhook authenticity | HMAC-SHA256 signature verified over the raw body before *anything* else runs (accepts the Instagram **or** Facebook app-secret signature - Meta uses either depending on app type) |
| Token safety | Instagram tokens + your App Secret are AES-256-GCM encrypted at rest; auto-refreshed before their 60-day expiry |

**Build and test with zero waiting:** in Development mode your app already delivers real events for the
accounts on your app (you + testers you add) - so you can fully build, test and run automations within your
own circle immediately, no approval needed. When you want the **general public's** comments to trigger your
automations, submit Meta's free **App Review** once (a short screencast of your working flow - typically
approved in days). The in-app Setup Wizard walks you through both stages.

## 🏗️ Architecture

The fork runs a Next.js app and a persistent worker against Supabase. Its background cycles handle bot transport, Reel publishing, Instagram Insights, advertising rules and the original automation engine. The diagram below shows the original comment-to-DM flow; see [the project guide](docs/PROJECT_GUIDE.md) for the full service.

```
Instagram comment
      │
      ▼
Meta webhook ──► /api/webhook ── verify HMAC ── 200 OK to Meta (< 1s)
                                      │ after() - background of same invocation
                                      ▼
                          match keyword/post ─► job row in Postgres (job_queue)
                                      │
                                      ▼
                    engine claims job (FOR UPDATE SKIP LOCKED)
                    window check → dedup → rate limit → jitter → send DM
                                      │
              ┌───────────────────────┴─────────────────────┐
   sent instantly (95% case)              rate-limited / transient error
                                          → rescheduled with run_after
                                          → drained by pg_cron every minute
```

- **Supabase** is the entire backend: Postgres (data + job queue + rate limiter), Auth, Storage (card images), and pg_cron (background ticks).
- **Hosting:** the original comment automation supports Vercel and Cloudflare (via OpenNext). The full fork's background modules use the persistent worker described in [DEPLOYMENT.md](docs/DEPLOYMENT.md).

## 🚀 Quick start

The full fork uses Supabase, a Meta developer app and a host for the Next.js app plus persistent worker. Follow **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** for the full installation. **[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)** covers the original community deployment options.

```bash
# 1. Clone + install
git clone https://github.com/N1arko/open-autodm && cd open-autodm
npm ci

# 2. Configure the environment for the selected Supabase project
cp .env.example .env.local
# Fill in the variables described in the file and DEPLOYMENT.md

# 3. Apply migrations to the configured database
npm run migrate

# 4. Start the local app; run the worker in a separate terminal
npm run dev
# npm run worker

# 5. Configure Meta and the owner API using AGENT_API.md,
#    or use the existing Setup Wizard in the web panel
```

**No register page, on purpose.** Access is invite-only: accounts exist only when the instance
owner creates them in the Supabase dashboard (and public signups are switched off there too).
Your instance, your guest list.

The **Setup Wizard** inside the app walks you through creating the Meta app, gives you the
exact webhook URL / verify token / redirect URI to paste into the Meta portal, and generates
the one SQL snippet that turns on the background engine. ~15 minutes total.

## 🧪 Testing your instance

See **[docs/TESTING.md](docs/TESTING.md)** for the full end-to-end test script
(local dev with a Cloudflare/ngrok tunnel, the debug panel event flow you should see,
and a troubleshooting table for every failure mode we've ever hit).

## 🔐 Security model

- Deployment env holds Supabase credentials, encryption/cron secrets and optional owner API authentication settings; see `.env.example`.
- Meta App ID/Secret are entered in the UI and stored **AES-256-GCM encrypted** in your own DB.
- Instagram OAuth tokens: encrypted at rest, decrypted only at send time, never logged.
- Webhooks: HMAC-verified (timing-safe compare) before any processing.
- OAuth: CSRF-protected with signed, 10-minute state JWTs.
- Owner routes accept allowed Supabase sessions or the configured owner management credential; bot reply routes accept account-scoped integration credentials. Ownership is checked by the module's API and SQL rules. Meta webhooks use signature verification.
- Row Level Security on every table, service-role isolation for engine tables.

## 🤝 Contributing

Feature ideas and pull requests are very welcome - open an issue to discuss bigger changes
first, then send a PR. **More features are actively being added; watch the repo to keep up.**
If you build something cool on top of this, share it in an issue so others can find it.

## ☕ Support this project

open-autoDM is free forever and saves you a real monthly subscription. If it saved you money
or a weekend of building, you can fuel the next feature:

<a href="https://github.com/sponsors/harshithgangone" target="_blank"><img src="https://img.shields.io/badge/❤️_Sponsor-support_the_project-F97316?style=for-the-badge&logo=githubsponsors" alt="Sponsor on GitHub" /></a>

Starring the repo is free and helps just as much. ⭐

## 📄 License

MIT - use it, modify it, self-host it for yourself or your clients, commercially or not.
See [LICENSE](LICENSE).

## ⚠️ Disclaimer

- This software is provided **"as is", without warranty of any kind** - see the LICENSE. The
  author is **not liable** for anything that happens through your use of it, including (but not
  limited to) actions Meta or Instagram takes on your account or app.
- open-autoDM talks to Instagram exclusively through **Meta's official APIs** using **your own**
  Meta developer app and credentials. It never scrapes, never automates a browser, and never
  asks for your Instagram password.
- Built-in safety rails (conservative rate limits, humanized delays, dedup, circuit breaker)
  are designed to keep you inside Meta's published policies - but **you** are responsible for
  how you use automation and for your own compliance with Instagram's Terms of Use and Meta's
  Platform Policies.
- This project is not affiliated with, endorsed by, or sponsored by Meta, Instagram, or any
  automation vendor mentioned for comparison.

---

<div align="center">

Built with ❤️ by <a href="https://www.instagram.com/buildwharsha/"><b>@buildwharsha</b></a> - say hi on Instagram

</div>
