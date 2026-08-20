# pokebot

Tools for catching Pokémon TCG drops at Walmart and Target. Four pieces:

0. **`desktop/`** — an Electron wrapper: the dashboard as a double-clickable
   app with a tray icon, no terminal and no Node install. It hosts the same
   server in-process and changes nothing about how the automation works.
1. **`app/`** — the dashboard itself. Manage the watchlist, control everything
   from one place, and watch live status across every SKU.
2. **`extension/`** — a Chrome extension that runs in *your* logged-in browser.
   The dashboard tells it what to watch; it opens a pinned tab per SKU, carts
   the item the instant it goes live, walks through checkout, and can place the
   order. This is the part that actually buys things.
3. **`src/`** — a standalone Node monitor that polls product pages and alerts
   you. Independent of the above; see the blocking caveat before relying on it.

```
dashboard  ──watchlist + settings──▶  extension  ──clicks──▶  your browser
    ▲                                     │
    └──────────── live events ────────────┘
```

The dashboard never touches a retailer site. It holds state and shows you
what's happening; every click stays in your real session, which is the only
place it works.

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

**Two things it will never do**, and these aren't settings:

- **Answer a CAPTCHA.** If a bot check appears at any step it stops and alerts
  you to solve it yourself. That's the line, and it's why this approach works
  at all — nothing here is trying to look like something it isn't.
- **Touch your card details.** Checkout uses the payment method and address
  already saved in your retailer account. There is nowhere in this extension a
  card number could be stored, and nothing is transmitted anywhere.

## Quick start

Pick the path that matches who's installing.

### A. Desktop app — no terminal, nothing to install

Download the installer for your platform from the
[Releases page](../../releases) and run it. Node is bundled; there is nothing
else to set up.

The app runs in the tray/menu bar. Closing the window keeps it watching —
quit from the tray icon.

> Builds are unsigned, so the first launch shows a publisher warning.
> macOS: right-click the app → **Open** → **Open**.
> Windows: **More info** → **Run anyway**.

If Releases is empty, run the **Build desktop app** workflow from the Actions
tab (or push a `v*` tag) and it will build all three installers.

### B. Just the dashboard, from source

```bash
npm install --omit=dev     # skips Electron (~300MB) — you don't need it
npm run app                # dashboard at http://127.0.0.1:8787
```

`--omit=dev` matters: a plain `npm install` pulls the Electron toolchain,
which is a large download and unnecessary unless you're building installers.

### C. Working on the desktop app

```bash
npm install                # includes Electron + electron-builder
npm run desktop            # launch the app from source
npm run build:desktop      # build an installer for your current platform
```

### Then: the extension

However you started the dashboard, the clicking still happens in your real
Chrome. Load it once: `chrome://extensions` → **Developer mode** →
**Load unpacked** → select `extension/`. It finds the dashboard on its own and
the header pill flips to **extension connected**.

From there, everything is in the dashboard:

1. Paste product URLs into the watchlist. The extension opens a pinned tab for
   each one automatically — you don't manage tabs by hand.
2. Set **max item price** and **max order total**.
3. Leave **dry run on**, turn **armed on**. Watch the activity feed.
4. Once you've seen it fire correctly, turn **dry run off**.
5. For full checkout, turn on **auto-checkout**, then **place order**.

The header pill tells you what mode you're in at a glance, and goes red when
it's live and able to spend.

Saving a payment method and address in your Walmart/Target accounts first is
required — checkout can't complete without them.

### Remote access

Localhost only by default. To reach it from your phone on the same wifi:

```bash
POKEBOT_LAN=1 POKEBOT_TOKEN=$(openssl rand -hex 12) npm run app
```

It refuses to start in LAN mode without a token, and prints the URL to open.

### Running the extension without the dashboard

It still works standalone — the popup has the same settings and the bridge just
retries quietly in the background. You manage tabs yourself in that mode.

Settings:

| Setting | What it does |
|---|---|
| **Armed** | Off = alert only, never clicks. |
| **Dry run** | Logs every click without making it. Default on. |
| **Max price** | Won't cart above this — guards against a marketplace reseller listing replacing the sold-out first-party one. |
| **Min price** | Won't cart *below* this. 0 = off. A drop is a lineup — the box you want sits beside blisters and sticker packs at a fifth of the price, and with one auto-add per window whichever is seen first is the one bought. A maximum alone can't tell them apart. |
| **Re-check every** | Safety-net poll; a MutationObserver catches most changes instantly. |
| **Reload page every** | 0 = never. Use 30s+; faster invites a bot check. |
| **Auto-continue to checkout** | Walks cart → checkout, then stops with the order ready to submit. |
| **Place the order** | Submits it. Requires auto-continue. Default off. |
| **Max order total** | Checked against the total the checkout page actually shows, after tax and shipping. |
| **Max items in order** | Refuses to submit a cart bigger than this. |
| **Max orders per day** | Persisted across tabs and reloads. Default 1. |

Changing any of these applies to tabs already open — you don't reload to make
a toggle count. A tab that stopped *because* of a setting picks up again when
that setting changes: raise the cap on something it refused and it re-checks.
A bot check and an already-placed cart are the exceptions, and stay stopped —
one needs you, and the other must not be repeated by flipping a switch.

### Queues

A hyped Walmart drop goes behind a virtual waiting room: Add to cart puts you
in line, and some minutes later you are released with a short window to
finish. Two of this extension's ordinary behaviours are wrong there, so both
are suppressed while a queue is showing:

- **It does not navigate.** The hop to `/cart` after a successful cart is right
  normally and forfeits your place here.
- **It does not click.** A waiting room has buttons of its own, and none of
  them should be pressed by anything but a person.

The tab reports `queued`, raises a desktop notification, shows a banner, and
waits. When you are released it picks up on its own — cart, checkout, submit —
and that path takes seconds, so a several-minute window is ample.

Detection is on wording, not markup: the queue is often a third-party product
(Queue-it and similar) whose DOM is not the retailer's. A false positive costs
one tab that waits for you; a false negative costs the drop. It errs toward
waiting.

### The order-submission guardrails

Money-spending is gated on all of these, and any failure is terminal rather
than a retry:

- **Unreadable total = no submit.** If it can't parse the order total with
  confidence it refuses rather than submitting blind. Same principle as the
  cart logic refusing to click without a price.
- **The total it checks is the checkout page's own total**, after tax and
  shipping — not the item price. A sneaky extra line item can't slip through
  under an item-level cap.
- **The daily budget is claimed *before* the click**, not after. The click
  navigates the page away, so an after-the-fact write would never land and the
  guard would be decorative.
- **Esc, or the STOP button** in the on-page banner, aborts immediately. The
  banner is always visible while it's live, in red when it's about to spend.

All of these have tests that assert zero clicks on the submit button. That's
the assertion that matters — see `test/checkout.test.js`.

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

## Finding drops you haven't added yet

The watchlist assumes you already know the URL. For a real drop you often
don't — the product page may not exist until minutes before it goes live.
Discovery fills that in from two sources, both surfaced in the dashboard's
**Discovered** panel:

- **Subreddit announcements.** Communities like r/pkmntcgdeals post
  *"TARGET DROP TONIGHT 3am EST"* hours ahead. That's the earliest usable
  signal there is, because it predates the listing. Read over Reddit's public
  Atom feed, no auth. Reddit rate-limits unauthenticated polling hard, so the
  interval is unhurried and 429s double it rather than triggering a retry.
- **Retailer search pages.** With a Walmart or Target search or category page
  open in a tab, the extension reports product links as they appear —
  including ones added while you're watching. This is the fast path.

Both are filtered against your keywords, so the socks that share a results
page with the ETB don't end up on the watchlist.

Finds land in a review queue and are **not watched until you press Watch**.
`Add finds automatically` skips that step, and is off by default for a
specific reason: an auto-added URL inherits your live settings, so a bad
keyword match could be armed against your real payment method.

### Scheduled drops

Restocks happen on a clock. Walmart's Pokémon drops land at 9pm Eastern on
Wednesdays, and the product page frequently doesn't exist until it happens —
so there is nothing to watch beforehand and no point polling hard all week.

Set a **drop window** in Discovery settings: the days, the time, and a lead and
trail around it. Inside the window the search watcher re-queries every
`dropSearchSeconds` (default 10) instead of `searchSeconds` (default 90).
Outside it, nothing changes.

| Setting | What it does |
|---|---|
| **Drop days / time** | When the window opens. 24-hour clock. |
| **Timezone** | An IANA name like `America/New_York`, never `EST`. |
| **Open early / keep open after** | Minutes of lead and trail around the drop. |
| **Re-query search every** | The all-week interval. Floored at 5s. |
| **…and in the window** | The interval used while the window is open. |
| **Auto-add during the window** | Auto-adds matching finds, but only while it's open. |
| **Open the search tabs itself** | Opens the pages below when the window opens, closes them when it shuts. |
| **Search pages to watch** | Walmart/Target search, browse or category URLs. |
| **Only brand-new listings** | Ignore everything already on the page when the tab opens. |

**Only brand-new listings** is the setting that makes a drop-night run safe.
When a search tab opens it spends a few seconds recording what is already
listed, reports none of it, and reports only what appears afterwards. Without
it the first scrape announces the entire existing catalogue -- and with
auto-add on, that means carting whatever old stock happens to be in stock
while the actual drop is still minutes away. The Activity feed shows a
`baselined` line with the count it decided to ignore.

The consequence worth knowing: the tab has to be open *before* the drop. The
lead time exists for exactly this, and the re-query is held off until the
baseline finishes so a fast interval cannot cut it short.

Absence from the page is not enough on its own. A results page churns as
availability flips, so an old set that was out of stock at 02:45 reappears on
page one at 03:10 and looks brand new. The baseline therefore also records the
**highest product id** it saw, and nothing at or below that is ever reported.
Both retailers issue ids that climb over time, so a genuinely new listing is
above the floor and every reappearing old SKU is below it. The `baselined`
line in the feed names the floor it chose.

**Max auto-adds per window** caps how many finds one window may add. Each added
item opens its own pinned tab and carts independently -- `maxCarts` is *per
tab* -- so an uncapped window can fill a cart with a dozen things, and the tab
count alone is enough to earn a bot check. Finds beyond the cap wait in
**Discovered** rather than being thrown away.

With **Open the search tabs itself** on, you don't have to remember to leave a
tab open on a Wednesday afternoon — the extension opens the pages when the
window opens and closes them again afterwards. Only `https` URLs on
`www.walmart.com` or `www.target.com` are ever opened; the list becomes
`chrome.tabs.create` calls in a browser you are logged into, so it isn't
somewhere to trust whatever ended up in the settings file.

The timezone is a zone name rather than an offset on purpose. `EST` is −5 all
year; `America/New_York` is −5 in January and −4 in July. Storing the offset
would leave the watcher firing an hour off for two thirds of the year — and it
would do it silently, on the one night it needed to be right. There's a test
pinning the same schedule firing correctly in August and in November.

The header shows a countdown to the next window, and turns red while one is
open. The window is computed on the dashboard, so the timezone arithmetic
lives in one place and the extension is told nothing but a boolean.

**`Auto-add during the window` is narrower than `Add finds automatically`** —
it applies only while the window is open, instead of around the clock. It is
still auto-add: a matching find goes straight onto the watchlist and inherits
your live settings, so if you are armed and out of dry run it can cart without
you. Max item price, max items per order and max orders per day are what stand
between a bad keyword match and a bad purchase. Set them deliberately.

### Making the search tab actually useful

Two things matter more than they look:

**It re-queries, roughly every 90 seconds.** A results page is a snapshot —
it never updates itself. Without a periodic reload the tab would still be
showing the evening's results when the drop lands at 3am, and the watcher
would find nothing. Reported product ids are kept in `sessionStorage` so a
refresh doesn't re-announce the whole page.

**Sort by newest, don't use a plain search.** Relevance ranking buries a brand
new listing under established best-sellers, so a fresh SKU can take a long
time to surface — or never appear on page one at all. Point the tab at a
category sorted newest-first instead of `?searchTerm=pokemon`; the watcher
takes any Walmart or Target search, browse, or category URL.

## Discord

Both directions, both optional, both configured in `.env` rather than the
dashboard — a webhook URL and a bot token are bearer credentials, and
`config/app-state.json` gets copied and pasted around far too easily.

**Out — alerts to a channel.** Set `DISCORD_WEBHOOK_URL` (Server Settings →
Integrations → Webhooks → New Webhook). In-stock, carted, order placed,
refused-to-submit and bot-check events post as embeds with the product link.
Routine chatter like `watching` is deliberately excluded; mirroring it drowns
the channel and people mute it, which defeats the point.

Set `DISCORD_MENTION` to `@here`, `@everyone` or a role mention to ping — but
only the three events that need someone *now* (in stock, carted, bot check)
ever ping. The rest post silently.

**In — read links your group posts.** Set `DISCORD_BOT_TOKEN` and
`DISCORD_CHANNEL_IDS`. Any Walmart or Target product link posted in those
channels becomes a watchlist candidate, credited to whoever posted it. Links
inside embeds count too, so other stock bots in the channel feed this as well.

If your group already shares finds, this is usually the fastest source you
have — faster than the Reddit feed, and far more relevant.

Setup: create a bot at discord.com/developers/applications → Bot → Reset
Token, invite it to your server, and give it **Read Messages** and **Read
Message History** on those channels. The Message Content privileged intent is
*not* required — that applies to Gateway connections, and this reads over
REST. Channel ids come from enabling Developer Mode in Discord, then
right-clicking a channel → Copy Channel ID.

The first poll on each channel takes only the latest handful of messages, so
turning this on doesn't replay your channel's whole history as fresh finds.

### Why the search-page watcher matches on URL shape

Product links are found by path pattern (`/p/…/-/A-<tcin>`, `/ip/…/<id>`),
not by CSS class. Retailers restyle constantly but can't change those paths
without breaking every existing link to their own catalogue, so this survives
redesigns that would break a selector-based scraper.

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
desktop/
  main.js         Electron shell: hosts the dashboard, window + tray, single instance

app/
  server.js       HTTP + WebSocket hub; static UI, auth, broadcast
  state.js        Watchlist, settings and history; atomic JSON persistence
  public/         Dashboard UI (no build step, no framework)

extension/
  manifest.json   MV3; content scripts scoped to PDP, cart and checkout pages
  content.js      PDP: watches for an enabled cart control and clicks it
  checkout.js     Cart -> checkout -> submit, with the refusal checks
  bridge.js       Dashboard link; opens/closes a pinned tab per watched SKU
  background.js   Desktop notifications; relays events to the dashboard
  config.js       Settings, defaults, and the persisted daily order ledger
  options.html/js Standalone settings UI (mirrors the dashboard)

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
