// Pure helper functions — no AWS, no DOM. Kept dependency-free so they're
// easy to unit-test on their own later.

/**
 * Split a [start, end) interval into day/night minutes, walking boundary
 * by boundary so it's correct even if a session spans multiple day/night
 * crossings (rare for a single practice drive, but handled generally).
 *
 * @param {Date} start
 * @param {Date} end
 * @param {number} dayStartHour   e.g. 6   (6:00am, local time)
 * @param {number} nightStartHour e.g. 20  (8:00pm, local time)
 * @returns {{dayMinutes: number, nightMinutes: number}}
 */
export function splitDayNight(start, end, dayStartHour, nightStartHour) {
  let dayMs = 0;
  let nightMs = 0;
  let cur = new Date(start.getTime());
  const endMs = end.getTime();

  // Safety valve: never loop more than ~4 years of days.
  let guard = 0;

  while (cur.getTime() < endMs && guard < 5000) {
    guard++;
    const hour = cur.getHours() + cur.getMinutes() / 60 + cur.getSeconds() / 3600;
    const isDay = hour >= dayStartHour && hour < nightStartHour;

    // Compute the next boundary after `cur`, on the correct calendar day.
    const dayStart = startOfDayPlusHours(cur, dayStartHour);
    const nightStart = startOfDayPlusHours(cur, nightStartHour);

    let nextBoundary;
    if (isDay) {
      nextBoundary = nightStart > cur ? nightStart : addDays(nightStart, 1);
    } else if (hour < dayStartHour) {
      nextBoundary = dayStart > cur ? dayStart : addDays(dayStart, 1);
    } else {
      // after nightStart, before midnight -> next boundary is tomorrow's dayStart
      nextBoundary = addDays(dayStart, 1);
    }

    const segmentEnd = nextBoundary.getTime() < endMs ? nextBoundary : end;
    const segMs = segmentEnd.getTime() - cur.getTime();

    if (isDay) dayMs += segMs;
    else nightMs += segMs;

    cur = segmentEnd;
  }

  return {
    dayMinutes: Math.round(dayMs / 60000),
    nightMinutes: Math.round(nightMs / 60000)
  };
}

function startOfDayPlusHours(date, hours) {
  const d = new Date(date.getTime());
  d.setHours(0, 0, 0, 0);
  d.setTime(d.getTime() + hours * 3600000);
  return d;
}

function addDays(date, n) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + n);
  return d;
}

/** Format milliseconds as HH:MM:SS for the live timer. */
export function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

/** Format minutes as e.g. "1h 25m" for summaries. */
export function formatMinutes(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = Math.round(totalMinutes % 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

export function formatHoursDecimal(totalMinutes) {
  return (totalMinutes / 60).toFixed(1);
}

export function uid() {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  );
}

export function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
