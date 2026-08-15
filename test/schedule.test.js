'use strict';

/**
 * Drop-window scheduling, including the daylight-saving behaviour that makes
 * storing a zone name rather than an offset worth the trouble.
 */

const test = require('node:test');
const assert = require('node:assert');

const { dropWindow, parseTime, parseDays, scheduleFrom } = require('../src/discovery/schedule');

const WEDNESDAY_9PM = {
  enabled: true,
  time: '21:00',
  timeZone: 'America/New_York',
  days: ['wednesday'],
  leadMinutes: 10,
  trailMinutes: 20,
};

/** 2026-08-19 and 2026-11-18 are both Wednesdays -- one EDT, one EST. */
const SUMMER_9PM_ET = new Date('2026-08-20T01:00:00Z'); // 21:00 EDT (UTC-4)
const WINTER_9PM_ET = new Date('2026-11-19T02:00:00Z'); // 21:00 EST (UTC-5)

test('parseTime accepts wall-clock times and rejects nonsense', () => {
  assert.strictEqual(parseTime('21:00'), 21 * 60);
  assert.strictEqual(parseTime('9:05'), 9 * 60 + 5);
  assert.strictEqual(parseTime('00:00'), 0);
  for (const bad of ['24:00', '21:60', '9pm', '', null, undefined, '21-00']) {
    assert.strictEqual(parseTime(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('parseDays is case-insensitive and drops unknown names', () => {
  assert.deepStrictEqual(parseDays(['Wednesday']), [3]);
  assert.deepStrictEqual(parseDays([' sunday ', 'SATURDAY']), [0, 6]);
  assert.deepStrictEqual(parseDays(['someday', 42, null]), []);
  assert.deepStrictEqual(parseDays('wednesday'), [], 'a bare string is not a list');
});

test('the window is active at the drop minute in summer and in winter', () => {
  // The whole point of an IANA zone: one stored schedule, correct on both
  // sides of the DST boundary. An offset of -5 would be an hour out in August.
  assert.strictEqual(dropWindow(SUMMER_9PM_ET, WEDNESDAY_9PM).active, true);
  assert.strictEqual(dropWindow(WINTER_9PM_ET, WEDNESDAY_9PM).active, true);
});

test('a fixed-offset reading of the same instant would be wrong in summer', () => {
  // 01:00Z is 21:00 EDT but 20:00 EST. Pinning the zone to a winter offset
  // puts the watcher an hour early -- this asserts we are not doing that.
  const summerLocalHourUTCMinus5 = new Date(SUMMER_9PM_ET.getTime() - 5 * 3600 * 1000).getUTCHours();
  assert.strictEqual(summerLocalHourUTCMinus5, 20, 'sanity check on the fixture');
  assert.strictEqual(dropWindow(SUMMER_9PM_ET, WEDNESDAY_9PM).active, true);
});

test('the lead opens the window early and the trail closes it late', () => {
  const at = (minutes) => new Date(SUMMER_9PM_ET.getTime() + minutes * 60 * 1000);

  assert.strictEqual(dropWindow(at(-11), WEDNESDAY_9PM).active, false, 'before the lead');
  assert.strictEqual(dropWindow(at(-10), WEDNESDAY_9PM).active, true, 'lead boundary');
  assert.strictEqual(dropWindow(at(0), WEDNESDAY_9PM).active, true);
  assert.strictEqual(dropWindow(at(20), WEDNESDAY_9PM).active, true, 'trail boundary');
  assert.strictEqual(dropWindow(at(21), WEDNESDAY_9PM).active, false, 'after the trail');
});

test('other weekdays are not drop days', () => {
  const tuesday9pm = new Date('2026-08-19T01:00:00Z');
  const thursday9pm = new Date('2026-08-21T01:00:00Z');
  assert.strictEqual(dropWindow(tuesday9pm, WEDNESDAY_9PM).active, false);
  assert.strictEqual(dropWindow(thursday9pm, WEDNESDAY_9PM).active, false);
});

test('a window that spills past midnight stays active into the next day', () => {
  const lateNight = {
    ...WEDNESDAY_9PM, time: '23:50', leadMinutes: 5, trailMinutes: 30,
  };
  // 00:10 Thursday ET is still inside Wednesday's 23:50 window.
  const justAfterMidnight = new Date('2026-08-20T04:10:00Z');
  assert.strictEqual(dropWindow(justAfterMidnight, lateNight).active, true);
});

test('a lead that reaches back before midnight opens on the previous day', () => {
  const justAfterMidnight = {
    ...WEDNESDAY_9PM, time: '00:10', leadMinutes: 30, trailMinutes: 10,
  };
  // 23:50 Tuesday ET is inside Wednesday 00:10's 30-minute lead.
  const lateTuesday = new Date('2026-08-19T03:50:00Z');
  assert.strictEqual(dropWindow(lateTuesday, justAfterMidnight).active, true);
});

test('minutesUntilNext counts down to the drop and keeps counting inside it', () => {
  const at = (minutes) => new Date(SUMMER_9PM_ET.getTime() + minutes * 60 * 1000);

  assert.strictEqual(dropWindow(at(-30), WEDNESDAY_9PM).minutesUntilNext, 30);
  assert.strictEqual(dropWindow(at(0), WEDNESDAY_9PM).minutesUntilNext, 0);
  // Past the drop, the next one is a week out.
  assert.strictEqual(dropWindow(at(5), WEDNESDAY_9PM).minutesUntilNext, 7 * 24 * 60 - 5);
});

test('disabled, unscheduled, or malformed schedules are simply inactive', () => {
  const cases = [
    { ...WEDNESDAY_9PM, enabled: false },
    { ...WEDNESDAY_9PM, days: [] },
    { ...WEDNESDAY_9PM, time: 'whenever' },
    { ...WEDNESDAY_9PM, timeZone: 'Mars/Olympus_Mons' },
    {},
  ];
  for (const schedule of cases) {
    const result = dropWindow(SUMMER_9PM_ET, schedule);
    assert.strictEqual(result.active, false, JSON.stringify(schedule));
  }
});

test('an unknown timezone does not throw on every tick', () => {
  assert.doesNotThrow(() => dropWindow(SUMMER_9PM_ET, { ...WEDNESDAY_9PM, timeZone: 'Nope/Nope' }));
});

test('scheduleFrom reads the shape the dashboard persists', () => {
  const schedule = scheduleFrom(
    {
      dropScheduleEnabled: true,
      dropTime: '21:00',
      dropTimeZone: 'America/New_York',
      dropLeadMinutes: 10,
      dropTrailMinutes: 20,
    },
    { dropDays: ['wednesday'] },
  );
  assert.strictEqual(dropWindow(SUMMER_9PM_ET, schedule).active, true);
});
