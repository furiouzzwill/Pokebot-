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
| **Re-check every** | Safety-net poll; a MutationObserver catches most changes instantly. |
| **Reload page every** | 0 = never. Use 30s+; faster invites a bot check. |
| **Auto-continue to checkout** | Walks cart → checkout, then stops with the order ready to submit. |
| **Place the order** | Submits it. Requires auto-continue. Default off. |
| **Max order total** | Checked against the total the checkout page actually shows, after tax and shipping. |
| **Max items in order** | Refuses to submit a cart bigger than this. |
| **Max orders per day** | Persisted across tabs and reloads. Default 1. |

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
