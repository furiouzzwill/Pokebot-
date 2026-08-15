'use strict';

/**
 * Wall-clock drop windows.
 *
 * Retailers run restocks at a fixed local time -- Walmart's Pokemon drops land
 * at 9pm Eastern on Wednesdays -- and the product page usually does not exist
 * until it happens. Everything else in this codebase polls on an interval;
 * this is the only part that cares what time it actually is.
 *
 * The zone is stored as an IANA name, never an offset. "EST" is -5 all year
 * round, while America/New_York is -5 in January and -4 in July. Storing the
 * offset would leave the watcher firing an hour late for the two thirds of the
 * year the region is on daylight time -- and it would do it silently, on the
 * one night it needed to be right.
 */

const DAYS = [
  'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
];

const MINUTES_PER_DAY = 24 * 60;

/** "21:00" -> 1260. Returns null on anything unparseable. */
function parseTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** Day names -> indices, ignoring anything that isn't a day. */
function parseDays(days) {
  if (!Array.isArray(days)) return [];
  const indices = new Set();
  for (const day of days) {
    const index = DAYS.indexOf(String(day ?? '').trim().toLowerCase());
    if (index !== -1) indices.add(index);
  }
  return [...indices];
}

/**
 * The wall-clock weekday and minutes-since-midnight at `instant`, as seen in
 * `timeZone`. Intl does the DST arithmetic, which is the entire reason this
 * goes through a formatter rather than getHours().
 */
function localParts(instant, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = {};
  for (const part of formatter.formatToParts(instant)) parts[part.type] = part.value;

  // hourCycle h23 still emits "24" for midnight on some ICU builds.
  const hour = Number(parts.hour) % 24;
  return {
    day: DAYS.indexOf(String(parts.weekday).toLowerCase()),
    minutes: hour * 60 + Number(parts.minute),
  };
}

/**
 * Where `instant` sits relative to the configured drop.
 *
 * @returns {{active: boolean, minutesUntilNext: number|null}}
 *   `active` is true inside [drop - lead, drop + trail]. `minutesUntilNext` is
 *   whole minutes to the next scheduled drop, or null when nothing is
 *   scheduled -- it keeps counting down while a window is active, so the UI can
 *   say "in 3 minutes" and "live now" from the same call.
 */
function dropWindow(instant, schedule = {}) {
  const idle = { active: false, minutesUntilNext: null };

  if (!schedule.enabled) return idle;

  const target = parseTime(schedule.time);
  const days = parseDays(schedule.days);
  if (target === null || days.length === 0) return idle;

  const zone = schedule.timeZone || 'America/New_York';
  let local;
  try {
    local = localParts(instant, zone);
  } catch {
    // An unknown zone name would otherwise throw on every tick.
    return idle;
  }
  if (local.day === -1) return idle;

  const lead = Math.max(0, Number(schedule.leadMinutes) || 0);
  const trail = Math.max(0, Number(schedule.trailMinutes) || 0);

  // Offsets -1, 0 and +1 cover a window that spills over midnight in either
  // direction: at 00:10 the relevant drop may have been yesterday's.
  let active = false;
  for (const offset of [-1, 0, 1]) {
    const day = (local.day + offset + 7) % 7;
    if (!days.includes(day)) continue;
    const delta = local.minutes - (target + offset * MINUTES_PER_DAY);
    if (delta >= -lead && delta <= trail) {
      active = true;
      break;
    }
  }

  let minutesUntilNext = null;
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = (local.day + offset) % 7;
    if (!days.includes(day)) continue;
    const delta = offset * MINUTES_PER_DAY + target - local.minutes;
    if (delta < 0) continue;
    if (minutesUntilNext === null || delta < minutesUntilNext) minutesUntilNext = delta;
  }

  return { active, minutesUntilNext };
}

/** The schedule as stored in settings + rules, in the shape dropWindow wants. */
function scheduleFrom(settings = {}, rules = {}) {
  return {
    enabled: Boolean(settings.dropScheduleEnabled),
    time: settings.dropTime,
    timeZone: settings.dropTimeZone,
    leadMinutes: settings.dropLeadMinutes,
    trailMinutes: settings.dropTrailMinutes,
    days: rules.dropDays,
  };
}

module.exports = { DAYS, dropWindow, parseTime, parseDays, scheduleFrom };
