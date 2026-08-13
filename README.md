# pokebot

Tools for catching Pokémon TCG drops at Walmart and Target. Two pieces:

1. **`extension/`** — a Chrome extension that runs in *your* logged-in browser,
   watches a product tab you have open, and clicks **Add to cart** the instant
   the item goes live. This is the one that actually carts things.
2. **`src/`** — a standalone Node monitor that polls product pages and alerts
   you. Useful, but see the blocking caveat below before you rely on it.

---

## Why it's an extension and not a headless bot

The original plan was a server-side Puppeteer bot with 2Captcha and a stealth
plugin. Testing against the live sites killed that approach on the merits, and
the finding is worth knowing before you try it elsewhere:

Walmart serves a PerimeterX challenge to any non-browser client, and Target's
stock API returns `403` + a CAPTCHA to the same. So a headless bot has to
*defeat* those systems to do anything at all — and even when it works, a
human-solver CAPTCHA round-trip runs roughly 10–60 seconds, which is longer
than a hyped drop lasts. You'd pay per solve to arrive late.

Your own browser doesn't have that problem, because it isn't pretending to be
anything. You're already logged in, already trusted, already holding valid
session cookies. Nothing needs bypassing. That's why the carting logic lives in
an extension: it's both the legitimate approach and the *faster* one.

**Where it stops:** the extension adds to cart and hands off. It doesn't enter
payment details, submit orders, or answer CAPTCHAs. Set up a saved card and
address in your retailer account beforehand and checkout is a few taps —
carting is the part that's time-critical, and that's the part automated.

## Quick start — the extension (start here)

1. Chrome → `chrome://extensions` → turn on **Developer mode** →
   **Load unpacked** → select the `extension/` folder.
2. Click the extension icon. Set your **max price**. Leave **dry run on** and
   **armed on**.
3. Open the product page in a tab and leave it open.
4. Watch the console (`F12`) — you'll see `[pokebot] watching`. When stock
   lands it logs the click it *would* have made.
5. Once you've seen it fire correctly, turn **dry run off**. Now it clicks.

Settings:

| Setting | What it does |
|---|---|
| **Armed** | Off = alert only, never clicks. |
| **Dry run** | Logs the click without making it. Default on. |
| **Max price** | Won't cart above this — guards against a marketplace reseller listing replacing the sold-out first-party one. |
| **Re-check every** | Safety-net poll; a MutationObserver catches most changes instantly. |
| **Reload page every** | 0 = never. Use 30s+; faster invites a bot check. |

Notes from testing:

- It only clicks a purchase control that is **actually enabled** and inside the
  main product region. Target server-renders a *disabled* Add to cart button on
  every PDP, and recommendation carousels carry their own buttons — matching on
  button text alone carts the wrong thing, or everything.
- If a bot check appears, it stops and alerts you rather than trying to get
  around it. Solve it in the browser and reload.
- One cart per tab by default, so a re-render can't cart repeatedly.

Run the extension tests (real Chromium, real captured markup):

```bash
npm install --no-save playwright
npm run test:extension
```

## Quick start — the Node monitor

```bash
npm install
cp .env.example .env        # optional: webhook URLs, poll interval
npm run check -- "https://www.target.com/p/some-product/-/A-12345678"
```

Watch a list continuously:

```bash
# edit config/products.json, set "enabled": true, then:
npm start

# or pass URLs directly:
npm start -- "https://www.walmart.com/ip/thing/1234567890"
```

Run the tests (all offline, against captured fixtures):

```bash
npm test
```

## Read this before you rely on the Node monitor

**Both retailers block plain HTTP clients from reading stock.** The extension
sidesteps this entirely by running in a real session; this section is about the
standalone `src/` monitor only. This is not a
bug in the parsers and not something a better selector fixes. Verified against
the live sites:

| Site | What a plain HTTPS request actually gets |
|---|---|
| Walmart | A PerimeterX interstitial — `<title>Robot or human?</title>` with a `#px-captcha` mount — instead of the product page. |
| Target | The product HTML loads, but it contains **no stock data**. Every PDP server-renders a `disabled` "Add to cart" button and fills in availability client-side after hydration. The JSON API behind it (`redsky.target.com`) answers a non-browser client with `403` and a CAPTCHA URL. |

So out of the box you should expect `BLOCKED` from Walmart and `UNKNOWN` from
Target. The monitor reports both honestly rather than guessing.

That honesty is deliberate and it's the main thing protecting you. An earlier
version of the Target parser matched the string "Add to cart" in the page body
and reported **in stock for every product on the site** — because that disabled
button is always there. A restock alerter that cries wolf is worse than none:
you learn to ignore it, and then you miss the real drop. There's a regression
test pinning this (`test/blocking.test.js`).

### What actually works

Ranked by how well they hold up:

1. **Walmart's official affiliate/developer API.** Walmart publishes a product
   API (developer.walmart.com) with availability in the response. Free key,
   sanctioned access, no challenge pages, and vastly lighter on their infra
   than scraping a 400 KB page every poll. This is the right long-term source
   for the Walmart side — drop in an adapter under `src/sites/` that returns
   the same `{status, price, title}` shape and everything downstream works
   unchanged.
2. **Target's affiliate program** (run through Impact) similarly offers a
   sanctioned product data feed. Same integration story.
3. **A real browser you're actually using.** Stock is visible to a normal
   logged-in browser session because it *is* a normal session. A userscript or
   extension that watches a tab you already have open is a legitimate way to
   get alerts without pretending to be something you're not. That's a
   different program from this one, but it's the honest version of "headless
   browser".
4. **The retailers' own alerts** — Walmart's in-stock alerts on eligible items,
   and Pokémon Center's waitlists for first-party drops.

### What won't work

Turning the poll interval down, rotating user agents, or adding a stealth
plugin. The 403 and the PerimeterX page are the sites saying no to automated
access; the only thing faster polling changes is how quickly you get IP-banned.
The interval is clamped to a 5-second floor in `src/config.js` for that reason.

If you want carting today, use the extension — it doesn't have this problem.

## Architecture

```
extension/
  manifest.json   MV3; content script scoped to walmart.com/ip/* and target.com/p/*
  content.js      Watches the page, finds an enabled cart control, clicks it
  background.js   Desktop notifications; pulls the tab to the front on a hit
  config.js       Settings + defaults (dry run on, unarmed, $100 cap)
  options.html/js Settings UI

src/
  index.js        CLI: `check` (one-shot) and `watch` (continuous)
  monitor.js      Monitor class + checkProduct(); emits check/change/restock/blocked/error
  fetch.js        HTTP layer; one honest UA, surfaces 429/503 with Retry-After
  notify.js       Console, terminal bell, Discord, Slack, generic webhook
  config.js       Env + config/products.json loading, interval clamping
  utils.js        Logging (console + JSON logfile), sleep, jitter
  sites/
    index.js      URL -> adapter resolution
    common.js     Shared parsing: bot-challenge detection, JSON-LD, DOM heuristics
    walmart.js    __NEXT_DATA__ -> JSON-LD -> DOM
    target.js     inline state -> JSON-LD -> DOM
```

Each adapter runs ordered strategies, most authoritative first, and each
strategy returns `null` when its signal isn't present so the next one gets a
turn. Anything unrecognised comes back `UNKNOWN` rather than a guess.

### Status values

| Status | Meaning |
|---|---|
| `in_stock` | Positive signal. Fires a `restock` event on the transition into it. |
| `out_of_stock` | Positive out-of-stock signal. |
| `blocked` | Anti-bot challenge page. Not a stock reading — the last known status is left alone and the product backs off exponentially. |
| `unknown` | No usable signal. Parser may need updating, or stock is client-side. |

### Extending it

Add a site by dropping a module in `src/sites/` exporting `{key, label, matches(url), parse(html, url)}`
and registering it in `src/sites/index.js`. `parse` returns `{status, method, title, price}`.
The same shape works for an API-backed source — it doesn't have to parse HTML.

## Configuration

Everything is in `.env` (see `.env.example`) and `config/products.json`.

Notable settings:

- `POLL_INTERVAL_MS` — default 30000, floored at 5000. 30–60s is right for a drop.
- `POLL_JITTER_MS` — random spread so watched products don't burst on one tick.
- `RENOTIFY_MINUTES` — re-alert while an item stays in stock. 0 = alert once per transition.
- `DISCORD_WEBHOOK_URL` / `SLACK_WEBHOOK_URL` / `GENERIC_WEBHOOK_URL` — all optional.

There are deliberately no settings for account credentials, card details, or a
CAPTCHA-solver key. Nothing here needs them.

## Logging

Every action is timestamped. The console gets a readable line; `logs/pokebot-YYYY-MM-DD.log`
gets one JSON object per line, so a run can be grepped or replayed afterwards.
Set `LOG_LEVEL=debug` to log every individual check rather than only changes.
