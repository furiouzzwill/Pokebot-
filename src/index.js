'use strict';

const { config, loadProducts } = require('./config');
const { Monitor, checkProduct } = require('./monitor');
const { IN_STOCK, OUT_OF_STOCK, BLOCKED } = require('./sites/common');
const { notifyRestock } = require('./notify');
const { logger, humanDuration, truncate, closeLog, logFilePath } = require('./utils');

const USAGE = `
pokebot -- stock monitor for Pokemon drops at Walmart and Target

  npm run check -- <url>     Check one product URL once and print the result.
  npm start                  Watch every enabled product in config/products.json.
  npm start -- <url> [url…]  Watch the URLs given on the command line instead.

Options:
  --interval <ms>   Override poll interval (floor: ${config.poll.minIntervalMs}ms).
  --json            Machine-readable output (check only).
  --help

The monitor only reads public product pages and alerts you. It does not sign
in, add to cart, or place orders -- carting is yours to do.
`.trim();

function parseArgs(argv) {
  const args = { command: null, urls: [], json: false, interval: null, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--interval') args.interval = Number.parseInt(argv[++i], 10);
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else if (!args.command) args.command = arg;
    else args.urls.push(arg);
  }

  // `check <url>` and `watch <url>` both work, but so does a bare URL.
  if (args.command && /^https?:\/\//i.test(args.command)) {
    args.urls.unshift(args.command);
    args.command = 'watch';
  }

  return args;
}

function statusLabel(status) {
  if (status === IN_STOCK) return 'IN STOCK';
  if (status === OUT_OF_STOCK) return 'out of stock';
  if (status === BLOCKED) return 'BLOCKED';
  return 'UNKNOWN';
}

const BLOCKED_ADVICE =
  'The site returned an anti-bot challenge page instead of the product page, so stock cannot be read over plain HTTP. ' +
  'See the "What actually works" section of the README -- getting past this would mean defeating a CAPTCHA, which this project does not do.';

async function runCheck(urls, { json }) {
  if (urls.length === 0) {
    const products = loadProducts().filter((p) => p.enabled);
    if (products.length === 0) {
      throw new Error('No URL given and no enabled products in config/products.json');
    }
    urls = products.map((p) => p.url);
  }

  const results = [];
  let sawFailure = false;

  for (const url of urls) {
    try {
      const result = await checkProduct(url);
      results.push(result);
      if (!json) {
        logger.info(`${statusLabel(result.status).padEnd(12)} ${truncate(result.title || result.url, 70)}`, {
          site: result.site,
          via: result.method,
          took: `${result.elapsedMs}ms`,
        });
      }
    } catch (error) {
      sawFailure = true;
      results.push({ url, error: error.message });
      if (!json) logger.error(`FAILED       ${url}`, { error: error.message });
    }
  }

  if (json) console.log(JSON.stringify(results, null, 2));

  if (results.some((r) => r.status === BLOCKED)) {
    logger.warn(BLOCKED_ADVICE);
  } else if (results.some((r) => r.status === 'unknown')) {
    // UNKNOWN with no challenge page usually means a parser needs updating.
    logger.warn('Some products returned an unknown status: the page markup may have changed, or stock is rendered client-side on that page.');
  }

  return sawFailure ? 1 : 0;
}

async function runWatch(urls, { interval }) {
  const products = urls.length
    ? urls.map((url) => ({ name: url, url, enabled: true }))
    : loadProducts().filter((p) => p.enabled);

  if (products.length === 0) {
    throw new Error(
      'Nothing to watch. Add products to config/products.json (and set "enabled": true) or pass URLs on the command line.',
    );
  }

  const intervalMs = interval
    ? Math.max(interval, config.poll.minIntervalMs)
    : config.poll.intervalMs;

  if (config.poll.clamped && !interval) {
    logger.warn('POLL_INTERVAL_MS raised to the minimum', {
      requested: `${config.poll.requestedIntervalMs}ms`,
      using: `${intervalMs}ms`,
    });
  }

  logger.info('Starting monitor', {
    products: products.length,
    every: humanDuration(intervalMs),
    logfile: config.log.toFile ? logFilePath() : 'disabled',
  });
  for (const product of products) {
    logger.info(`  watching  ${truncate(product.name, 70)}`, { url: product.url });
  }

  const monitor = new Monitor(products, { intervalMs });

  monitor.on('check', (result) => {
    logger.debug(`${statusLabel(result.status)}  ${truncate(result.product.name, 50)}`, {
      via: result.method,
      took: `${result.elapsedMs}ms`,
    });
  });

  monitor.on('change', ({ from, to, result }) => {
    logger.info(`status change: ${statusLabel(from)} -> ${statusLabel(to)}`, {
      product: truncate(result.product.name, 50),
    });
  });

  monitor.on('restock', (result) => {
    notifyRestock(result).catch((err) => logger.error('Notify failed', { error: err.message }));
  });

  monitor.on('blocked', (result) => {
    logger.warn(`BLOCKED  ${truncate(result.product.name, 50)}`, { site: result.site });
    logger.warn(BLOCKED_ADVICE);
  });

  monitor.on('error', ({ product, error, consecutive }) => {
    logger.error('Check failed', {
      product: truncate(product.name, 50),
      error: error.message,
      consecutive,
    });
  });

  const shutdown = () => {
    logger.info('Shutting down…');
    monitor.stop();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await monitor.start();
  logger.info('Monitor stopped');
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || (!args.command && process.argv.length <= 2)) {
    console.log(USAGE);
    return 0;
  }

  switch (args.command) {
    case 'check':
      return runCheck(args.urls, args);
    case 'watch':
      return runWatch(args.urls, args);
    default:
      console.log(USAGE);
      throw new Error(`Unknown command: ${args.command}`);
  }
}

if (require.main === module) {
  main()
    .then((code) => {
      closeLog();
      process.exitCode = code ?? 0;
    })
    .catch((error) => {
      logger.error(error.message);
      closeLog();
      process.exitCode = 1;
    });
}

module.exports = { main, parseArgs };
