process.env.TZ = 'America/Los_Angeles';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  getCutoffsForDate,
  hasSunConfig,
  purgeLegacySunCache
} from '../js/sun.js';
import { splitDayNight } from '../js/utils.js';

const SEATTLE = {
  useAstronomicalSun: true,
  latitude: 47.6062,
  longitude: -122.3321,
  dayStartHour: 6,
  nightStartHour: 20
};

function localDate(year, month, day, hour = 12, minute = 0) {
  return new Date(year, month - 1, day, hour, minute);
}

function assertNear(actual, expected, tolerance, label) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${actual} to be within ${tolerance} hours of ${expected}`
  );
}

function localBoundary(date, decimalHour) {
  const totalMilliseconds = Math.round(decimalHour * 3600000);
  const boundary = new Date(date.getTime());
  boundary.setHours(
    Math.floor(totalMilliseconds / 3600000),
    Math.floor((totalMilliseconds % 3600000) / 60000),
    Math.floor((totalMilliseconds % 60000) / 1000),
    totalMilliseconds % 1000
  );
  return boundary;
}

test('calculates representative Seattle winter and summer cutoffs', async () => {
  const winter = await getCutoffsForDate(localDate(2026, 1, 15), SEATTLE);
  assertNear(winter.dayStartHour, 7.88, 0.2, 'winter sunrise');
  assertNear(winter.nightStartHour, 16.76, 0.2, 'winter sunset');

  const summer = await getCutoffsForDate(localDate(2026, 7, 15), SEATTLE);
  assertNear(summer.dayStartHour, 5.46, 0.2, 'summer sunrise');
  assertNear(summer.nightStartHour, 21.05, 0.2, 'summer sunset');
});

test('uses the device local timezone on both 2026 DST transition dates', async () => {
  const spring = await getCutoffsForDate(localDate(2026, 3, 8), SEATTLE);
  assert.ok(spring.dayStartHour > 7 && spring.dayStartHour < 8);
  assert.ok(spring.nightStartHour > 18.5 && spring.nightStartHour < 19.5);
  assert.ok(spring.dayStartHour < spring.nightStartHour);

  const fall = await getCutoffsForDate(localDate(2026, 11, 1), SEATTLE);
  assert.ok(fall.dayStartHour > 6 && fall.dayStartHour < 7.5);
  assert.ok(fall.nightStartHour > 16 && fall.nightStartHour < 17.5);
  assert.ok(fall.dayStartHour < fall.nightStartHour);
});

test('builds fractional cutoff boundaries using local civil time across DST', () => {
  const spring = splitDayNight(
    localDate(2026, 3, 8, 6),
    localDate(2026, 3, 8, 8),
    6.5,
    20
  );
  assert.deepEqual(spring, { dayMinutes: 90, nightMinutes: 30 });

  const fall = splitDayNight(
    localDate(2026, 11, 1, 5),
    localDate(2026, 11, 1, 8),
    6.5,
    20
  );
  assert.deepEqual(fall, { dayMinutes: 90, nightMinutes: 90 });

  const fractionalNight = splitDayNight(
    localDate(2026, 1, 15, 17, 45),
    localDate(2026, 1, 15, 18, 45),
    6.25,
    18.25
  );
  assert.deepEqual(fractionalNight, { dayMinutes: 30, nightMinutes: 30 });
});

test('splits drives at exact calculated Seattle sunrise and sunset milliseconds', async () => {
  const date = localDate(2026, 1, 15);
  const cutoffs = await getCutoffsForDate(date, SEATTLE);
  const sunrise = localBoundary(date, cutoffs.dayStartHour);
  const sunset = localBoundary(date, cutoffs.nightStartHour);

  assert.notEqual(sunrise.getMilliseconds(), 0);
  assert.notEqual(sunset.getMilliseconds(), 0);

  assert.deepEqual(
    splitDayNight(
      new Date(sunrise.getTime() - 10 * 60000),
      new Date(sunrise.getTime() + 10 * 60000),
      cutoffs.dayStartHour,
      cutoffs.nightStartHour
    ),
    { dayMinutes: 10, nightMinutes: 10 }
  );
  assert.deepEqual(
    splitDayNight(
      new Date(sunset.getTime() - 10 * 60000),
      new Date(sunset.getTime() + 10 * 60000),
      cutoffs.dayStartHour,
      cutoffs.nightStartHour
    ),
    { dayMinutes: 10, nightMinutes: 10 }
  );
});

test('maps polar daylight and darkness through the real day/night splitter', async () => {
  const polarSettings = { ...SEATTLE, latitude: 80, longitude: 0 };

  const summer = await getCutoffsForDate(localDate(2026, 6, 21), polarSettings);
  assert.deepEqual(summer, { dayStartHour: 0, nightStartHour: 24 });
  assert.deepEqual(
    splitDayNight(
      localDate(2026, 6, 21, 8),
      localDate(2026, 6, 21, 10),
      summer.dayStartHour,
      summer.nightStartHour
    ),
    { dayMinutes: 120, nightMinutes: 0 }
  );

  const winter = await getCutoffsForDate(localDate(2026, 12, 21), polarSettings);
  assert.deepEqual(winter, { dayStartHour: 0, nightStartHour: 0 });
  assert.deepEqual(
    splitDayNight(
      localDate(2026, 12, 21, 8),
      localDate(2026, 12, 21, 10),
      winter.dayStartHour,
      winter.nightStartHour
    ),
    { dayMinutes: 0, nightMinutes: 120 }
  );
});

test('preserves valid cutoffs on entry to and exit from polar daylight', async () => {
  const polarSettings = { ...SEATTLE, latitude: 80, longitude: 120 };

  const entry = await getCutoffsForDate(localDate(2026, 4, 13), polarSettings);
  assert.ok(entry.dayStartHour > 9 && entry.dayStartHour < 11);
  assert.equal(entry.nightStartHour, 24);

  const exit = await getCutoffsForDate(localDate(2026, 8, 30), polarSettings);
  assert.equal(exit.dayStartHour, 0);
  assert.ok(exit.nightStartHour > 7 && exit.nightStartHour < 9);
});

test('returns manual cutoffs for disabled, missing, invalid, and inverted inputs', async () => {
  const fallback = { dayStartHour: 5.5, nightStartHour: 19.25 };
  const cases = [
    { ...SEATTLE, ...fallback, useAstronomicalSun: false },
    { ...SEATTLE, ...fallback, latitude: undefined },
    { ...SEATTLE, ...fallback, longitude: undefined },
    { ...SEATTLE, ...fallback, latitude: Number.NaN },
    { ...SEATTLE, ...fallback, latitude: 90.1 },
    { ...SEATTLE, ...fallback, longitude: -180.1 }
  ];

  for (const settings of cases) {
    assert.deepEqual(await getCutoffsForDate(localDate(2026, 1, 15), settings), fallback);
  }

  assert.deepEqual(await getCutoffsForDate(new Date('invalid'), { ...SEATTLE, ...fallback }), fallback);
  assert.deepEqual(await getCutoffsForDate(undefined, { ...SEATTLE, ...fallback }), fallback);

  const london = {
    ...SEATTLE,
    ...fallback,
    latitude: 51.5074,
    longitude: -0.1278
  };
  assert.equal(hasSunConfig(london), true);
  assert.deepEqual(await getCutoffsForDate(localDate(2026, 6, 21), london), fallback);

  assert.equal(hasSunConfig({ ...SEATTLE, latitude: -90, longitude: 180 }), true);
  assert.equal(hasSunConfig({ ...SEATTLE, latitude: Infinity }), false);
});

test('calculation has no fetch or localStorage dependency', async () => {
  const originalFetch = globalThis.fetch;
  const originalStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  globalThis.fetch = () => {
    throw new Error('fetch must not be used');
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('localStorage must not be used');
    }
  });

  try {
    const cutoffs = await getCutoffsForDate(localDate(2026, 4, 15), SEATTLE);
    assert.notDeepEqual(cutoffs, {
      dayStartHour: SEATTLE.dayStartHour,
      nightStartHour: SEATTLE.nightStartHour
    });
    assert.ok(Number.isFinite(cutoffs.dayStartHour));
    assert.ok(Number.isFinite(cutoffs.nightStartHour));
    assert.ok(cutoffs.dayStartHour < cutoffs.nightStartHour);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorageDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', originalStorageDescriptor);
    } else {
      delete globalThis.localStorage;
    }
  }
});

test('purges only snapshotted obsolete sun cache keys', () => {
  class MemoryStorage {
    constructor(entries) {
      this.entries = new Map(entries);
    }

    get length() {
      return this.entries.size;
    }

    key(index) {
      return [...this.entries.keys()][index] ?? null;
    }

    removeItem(key) {
      this.entries.delete(key);
    }
  }

  const storage = new MemoryStorage([
    ['drivelog.sun.v1|city-a|2026-01-01', 'obsolete'],
    ['drivelog.config.v1', 'preserve'],
    ['drivelog.sun.v1', 'obsolete'],
    ['drivelog.sun.v10|lookalike', 'preserve'],
    ['drivelog.sun.v1|city-b|2026-02-02', 'obsolete'],
    ['drivelog.other.v1', 'preserve'],
    ['drivelog.sun.v1-old', 'preserve'],
    ['drivelog.sun.v1|city-c|2026-03-03', 'obsolete']
  ]);

  purgeLegacySunCache(storage);

  assert.deepEqual([...storage.entries.keys()], [
    'drivelog.config.v1',
    'drivelog.sun.v10|lookalike',
    'drivelog.other.v1',
    'drivelog.sun.v1-old'
  ]);
  assert.doesNotThrow(() =>
    purgeLegacySunCache({
      get length() {
        throw new Error('blocked');
      }
    })
  );
});

test('app purges obsolete cache before boot selection and before reset reload', async () => {
  const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
  const topLevelPurge = appSource.indexOf('purgeLegacySunCache();');
  const bootSelection = appSource.indexOf('if (config) {');
  assert.ok(topLevelPurge >= 0 && topLevelPurge < bootSelection);

  const resetHandler = appSource.indexOf("document.getElementById('reset-device-btn')");
  const resetPurge = appSource.indexOf('purgeLegacySunCache();', resetHandler);
  const clearConfig = appSource.indexOf('clearConfig();', resetHandler);
  const reload = appSource.indexOf('location.reload();', resetHandler);
  assert.ok(resetHandler >= 0);
  assert.ok(resetPurge > resetHandler && resetPurge < clearConfig);
  assert.ok(clearConfig < reload);
});
