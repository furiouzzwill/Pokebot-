# pokebot

A stock monitor for Pokémon TCG drops at Walmart and Target. It watches public
product pages and tells you the moment something flips to in-stock, so you can
go buy it yourself.

It does not sign in, add to cart, or place orders.

---

## Scope: what this is and isn't

This started as a request for an auto-purchase bot: Puppeteer carting, 2Captcha
solving, stealth plugin, user-agent rotation. That part isn't built, and it
isn't a gap to fill in later — the CAPTCHA-solving and anti-detection pieces
exist specifically to defeat the retailers' bot controls, which is against both
sites' terms of use and is the machinery behind drop scalping.

What is built is the part that's both legitimate and genuinely the hard part:
knowing the instant a drop goes live. The carting is the easy ten seconds, and
it's yours.

## Quick start

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

## Read this before you rely on it

**Both retailers block plain HTTP clients from reading stock.** This is not a
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

## Architecture

```
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
