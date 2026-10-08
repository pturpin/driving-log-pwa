import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { renderHeaderProgress, renderProgressSummary } from '../js/progress.js';
import { calculateRequirementProgress, CLIENT_VERSION } from '../js/utils.js';

const hours = (value) => value * 60;

function fakeDocument() {
  const elements = new Map();
  return {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, { style: {}, textContent: '' });
      }
      return elements.get(id);
    }
  };
}

test('caps daytime credit while preserving room for the night minimum', () => {
  assert.deepEqual(
    calculateRequirementProgress(hours(45), hours(4), hours(50), hours(10)),
    {
      creditedDayMinutes: hours(40),
      creditedNightMinutes: hours(4),
      countedTotalMinutes: hours(44),
      remainingMinutes: hours(6)
    }
  );
});

test('credits night hours above the minimum until the total goal is filled', () => {
  assert.deepEqual(
    calculateRequirementProgress(hours(30), hours(15), hours(50), hours(10)),
    {
      creditedDayMinutes: hours(30),
      creditedNightMinutes: hours(15),
      countedTotalMinutes: hours(45),
      remainingMinutes: hours(5)
    }
  );
});

test('uses night hours to supplement capped daytime and caps at the total goal', () => {
  assert.deepEqual(
    calculateRequirementProgress(hours(45), hours(20), hours(50), hours(10)),
    {
      creditedDayMinutes: hours(40),
      creditedNightMinutes: hours(10),
      countedTotalMinutes: hours(50),
      remainingMinutes: 0
    }
  );
});

test('handles zero goals and a night goal greater than the total goal', () => {
  assert.deepEqual(
    calculateRequirementProgress(hours(5), hours(5), 0, 0),
    {
      creditedDayMinutes: 0,
      creditedNightMinutes: 0,
      countedTotalMinutes: 0,
      remainingMinutes: 0
    }
  );
  assert.deepEqual(
    calculateRequirementProgress(hours(20), hours(12), hours(10), hours(15)),
    {
      creditedDayMinutes: 0,
      creditedNightMinutes: hours(10),
      countedTotalMinutes: hours(10),
      remainingMinutes: 0
    }
  );
});

test('renders credited progress and actual requirement breakdown values', () => {
  const document = fakeDocument();
  const totals = {
    dayMinutes: hours(45),
    nightMinutes: hours(4)
  };
  const settings = {
    goalTotalHours: 50,
    goalNightHours: 10
  };

  renderHeaderProgress(document, totals, settings);
  renderProgressSummary(document, totals, settings);

  assert.equal(document.getElementById('header-progress-day').style.width, '80%');
  assert.equal(document.getElementById('header-progress-night').style.width, '8%');
  assert.equal(document.getElementById('header-progress-label').textContent, '6.0 hrs left');
  assert.equal(document.getElementById('gauge-total-hours').textContent, '44.0');
  assert.equal(document.getElementById('gauge-goal-hours').textContent, '50');
  assert.equal(document.getElementById('total-hours-value').textContent, '44.0 / 50 hrs');
  assert.equal(document.getElementById('night-hours-value').textContent, '4.0 / 10 hrs');
  assert.equal(document.getElementById('day-hours-value').textContent, '45.0 hrs');
});

test('renders zero-width progress safely when the total goal is zero', () => {
  const document = fakeDocument();
  const totals = {
    dayMinutes: hours(5),
    nightMinutes: hours(5)
  };
  const settings = {
    goalTotalHours: 0,
    goalNightHours: 0
  };

  renderHeaderProgress(document, totals, settings);
  renderProgressSummary(document, totals, settings);

  assert.equal(document.getElementById('header-progress-day').style.width, '0%');
  assert.equal(document.getElementById('header-progress-night').style.width, '0%');
  assert.equal(document.getElementById('header-progress-label').textContent, 'Goal reached');
  assert.equal(document.getElementById('gauge-total-hours').textContent, '0.0');
  assert.equal(document.getElementById('total-hours-value').textContent, '0.0 / 0 hrs');
  assert.equal(document.getElementById('night-hours-value').textContent, '5.0 / 0 hrs');
  assert.equal(document.getElementById('day-hours-value').textContent, '5.0 hrs');

  const circumference = 2 * Math.PI * 92;
  assert.equal(
    document.getElementById('gauge-day').style.strokeDasharray,
    `0 ${circumference}`
  );
  assert.equal(
    document.getElementById('gauge-night').style.strokeDasharray,
    `0 ${circumference}`
  );
  assert.equal(document.getElementById('gauge-night').style.strokeDashoffset, '0');
});

test('includes the Total Required explanation as an accessible styled disclosure', async () => {
  const [html, css] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../css/app.css', import.meta.url), 'utf8')
  ]);

  assert.match(html, /<span class="progress-label">Total Required<\/span>/);
  assert.match(html, /<details class="progress-info">/);
  assert.match(
    html,
    /<summary\s+class="progress-info-toggle"\s+aria-label="About Total Required hours"\s+aria-controls="total-required-info"\s*>i<\/summary>/
  );
  assert.match(html, /<div class="progress-info-popup" id="total-required-info">/);
  assert.match(
    html,
    /Daytime hours count toward the total only up to the total goal minus the night-hours goal\.\s+All night hours count toward the total until the total goal is reached\.\s+Day and Night below show all logged hours\./
  );

  assert.match(css, /\.progress-row\s*\{[^}]*position:\s*relative;/s);
  assert.match(
    css,
    /\.progress-info-toggle\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px;[^}]*border-radius:\s*50%;/s
  );
  assert.match(css, /:root\s*\{[^}]*--day:\s*#[0-9a-f]{6};/is);
  assert.match(
    css,
    /\.progress-info-toggle:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--day\);/s
  );
  assert.match(
    css,
    /\.progress-info-popup\s*\{[^}]*position:\s*absolute;[^}]*width:\s*min\(280px,\s*calc\(100vw - 40px\)\);/s
  );
});

test('aligns release versions and includes the progress renderer in the shell', async () => {
  const [workerSource, publishedVersion] = await Promise.all([
    readFile(new URL('../sw.js', import.meta.url), 'utf8'),
    readFile(new URL('../version.json', import.meta.url), 'utf8').then(JSON.parse)
  ]);

  assert.match(workerSource, /'\.\/js\/progress\.js'/);
  const shellVersion = workerSource.match(/const SW_VERSION = '([^']+)';/)?.[1];
  assert.equal(CLIENT_VERSION, publishedVersion.version);
  assert.equal(CLIENT_VERSION, shellVersion);
});
