const CACHE_PREFIX = 'drivelog.sun.v1';

function toIsoDateLocal(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseHourFraction(dateLike) {
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid sun time from API');
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}

function getCacheKey(lat, lon, dateKey) {
  return `${CACHE_PREFIX}|${lat.toFixed(4)}|${lon.toFixed(4)}|${dateKey}`;
}

export function hasSunConfig(settings) {
  return !!settings?.useAstronomicalSun && Number.isFinite(settings?.latitude) && Number.isFinite(settings?.longitude);
}

export async function getCutoffsForDate(date, settings) {
  const fallback = {
    dayStartHour: settings.dayStartHour,
    nightStartHour: settings.nightStartHour
  };

  if (!hasSunConfig(settings)) return fallback;

  const dateKey = toIsoDateLocal(date);
  const key = getCacheKey(settings.latitude, settings.longitude, dateKey);

  try {
    const cached = localStorage.getItem(key);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Number.isFinite(parsed.dayStartHour) && Number.isFinite(parsed.nightStartHour)) {
        return parsed;
      }
    }
  } catch {
    // Cache corruption should never block logging.
  }

  const url = new URL('https://api.sunrise-sunset.org/json');
  url.searchParams.set('lat', String(settings.latitude));
  url.searchParams.set('lng', String(settings.longitude));
  url.searchParams.set('date', dateKey);
  url.searchParams.set('formatted', '0');

  const res = await fetch(url.toString());
  if (!res.ok) return fallback;

  const payload = await res.json();
  if (payload.status !== 'OK' || !payload.results?.sunrise || !payload.results?.sunset) {
    return fallback;
  }

  const computed = {
    dayStartHour: parseHourFraction(payload.results.sunrise),
    nightStartHour: parseHourFraction(payload.results.sunset)
  };

  try {
    localStorage.setItem(key, JSON.stringify(computed));
  } catch {
    // Storage full/blocked should not block the user.
  }

  return computed;
}
