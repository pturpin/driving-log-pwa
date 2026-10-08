import { calculateRequirementProgress, formatHoursDecimal } from './utils.js';

function requirementProgress(totals, settings) {
  return calculateRequirementProgress(
    totals.dayMinutes,
    totals.nightMinutes,
    settings.goalTotalHours * 60,
    settings.goalNightHours * 60
  );
}

export function renderHeaderProgress(document, totals, settings) {
  const goalMinutes = settings.goalTotalHours * 60;
  const progress = requirementProgress(totals, settings);
  const dayPercent = goalMinutes > 0
    ? (progress.creditedDayMinutes / goalMinutes) * 100
    : 0;
  const nightPercent = goalMinutes > 0
    ? (progress.creditedNightMinutes / goalMinutes) * 100
    : 0;

  document.getElementById('header-progress-day').style.width = `${dayPercent}%`;
  document.getElementById('header-progress-night').style.width = `${nightPercent}%`;
  document.getElementById('header-progress-label').textContent =
    progress.remainingMinutes
      ? `${formatHoursDecimal(progress.remainingMinutes)} hrs left`
      : 'Goal reached';
}

export function renderProgressSummary(document, totals, settings) {
  const goalMinutes = settings.goalTotalHours * 60;
  const progress = requirementProgress(totals, settings);

  document.getElementById('gauge-total-hours').textContent =
    formatHoursDecimal(progress.countedTotalMinutes);
  document.getElementById('gauge-goal-hours').textContent =
    String(settings.goalTotalHours);
  document.getElementById('total-hours-value').textContent =
    `${formatHoursDecimal(progress.countedTotalMinutes)} / ${settings.goalTotalHours} hrs`;
  document.getElementById('night-hours-value').textContent =
    `${formatHoursDecimal(totals.nightMinutes)} / ${settings.goalNightHours} hrs`;
  document.getElementById('day-hours-value').textContent =
    `${formatHoursDecimal(totals.dayMinutes)} hrs`;

  const circumference = 2 * Math.PI * 92;
  const dayFraction = goalMinutes > 0 ? progress.creditedDayMinutes / goalMinutes : 0;
  const nightFraction = goalMinutes > 0 ? progress.creditedNightMinutes / goalMinutes : 0;
  const day = document.getElementById('gauge-day');
  const night = document.getElementById('gauge-night');
  day.style.strokeDasharray = `${circumference * dayFraction} ${circumference}`;
  night.style.strokeDasharray = `${circumference * nightFraction} ${circumference}`;
  night.style.strokeDashoffset = `${-circumference * dayFraction}`;
}
