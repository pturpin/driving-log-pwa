const LEGACY_CACHE_KEY = 'drivelog.sun.v1';
const LEGACY_CACHE_PREFIX = `${LEGACY_CACHE_KEY}|`;
const APPARENT_HORIZON_ZENITH_DEGREES = 90.833;

function degreesToRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function radiansToDegrees(radians) {
  return (radians * 180) / Math.PI;
}

function normalizeDegrees(degrees) {
  return ((degrees % 360) + 360) % 360;
}

function julianDay(year, month, day) {
  let adjustedYear = year;
  let adjustedMonth = month;
  if (adjustedMonth <= 2) {
    adjustedYear -= 1;
    adjustedMonth += 12;
  }

  const century = Math.floor(adjustedYear / 100);
  const correction = 2 - century + Math.floor(century / 4);
  return (
    Math.floor(365.25 * (adjustedYear + 4716)) +
    Math.floor(30.6001 * (adjustedMonth + 1)) +
    day +
    correction -
    1524.5
  );
}

function julianCentury(julianDate) {
  return (julianDate - 2451545) / 36525;
}

function solarCoordinates(julianDate) {
  const century = julianCentury(julianDate);
  const geometricMeanLongitude = normalizeDegrees(
    280.46646 + century * (36000.76983 + century * 0.0003032)
  );
  const geometricMeanAnomaly = 357.52911 + century * (35999.05029 - 0.0001537 * century);
  const orbitEccentricity =
    0.016708634 - century * (0.000042037 + 0.0000001267 * century);

  const anomalyRadians = degreesToRadians(geometricMeanAnomaly);
  const equationOfCenter =
    Math.sin(anomalyRadians) * (1.914602 - century * (0.004817 + 0.000014 * century)) +
    Math.sin(2 * anomalyRadians) * (0.019993 - 0.000101 * century) +
    Math.sin(3 * anomalyRadians) * 0.000289;
  const trueLongitude = geometricMeanLongitude + equationOfCenter;
  const omega = 125.04 - 1934.136 * century;
  const apparentLongitude = trueLongitude - 0.00569 - 0.00478 * Math.sin(degreesToRadians(omega));

  const meanObliquity =
    23 +
    (26 +
      (21.448 -
        century * (46.815 + century * (0.00059 - century * 0.001813))) /
        60) /
      60;
  const correctedObliquity = meanObliquity + 0.00256 * Math.cos(degreesToRadians(omega));
  const obliquityRadians = degreesToRadians(correctedObliquity);
  const apparentLongitudeRadians = degreesToRadians(apparentLongitude);
  const declinationRadians = Math.asin(
    Math.sin(obliquityRadians) * Math.sin(apparentLongitudeRadians)
  );

  const tangentHalfObliquity = Math.tan(obliquityRadians / 2);
  const y = tangentHalfObliquity * tangentHalfObliquity;
  const longitudeRadians = degreesToRadians(geometricMeanLongitude);
  const equationOfTime =
    4 *
    radiansToDegrees(
      y * Math.sin(2 * longitudeRadians) -
        2 * orbitEccentricity * Math.sin(anomalyRadians) +
        4 *
          orbitEccentricity *
          y *
          Math.sin(anomalyRadians) *
          Math.cos(2 * longitudeRadians) -
        0.5 * y * y * Math.sin(4 * longitudeRadians) -
        1.25 * orbitEccentricity * orbitEccentricity * Math.sin(2 * anomalyRadians)
    );

  return { declinationRadians, equationOfTime };
}

function solarHourAngle(latitude, declinationRadians) {
  const latitudeRadians = degreesToRadians(latitude);
  const cosine =
    (Math.cos(degreesToRadians(APPARENT_HORIZON_ZENITH_DEGREES)) -
      Math.sin(latitudeRadians) * Math.sin(declinationRadians)) /
    (Math.cos(latitudeRadians) * Math.cos(declinationRadians));

  if (!Number.isFinite(cosine)) return null;
  if (cosine > 1) return { state: 'darkness' };
  if (cosine < -1) return { state: 'daylight' };
  return { state: 'normal', radians: Math.acos(cosine) };
}

function solarEventUtcMinutes(julianDate, latitude, longitude, isSunrise) {
  let coordinates = solarCoordinates(julianDate);
  let hourAngle = solarHourAngle(latitude, coordinates.declinationRadians);
  if (!hourAngle || hourAngle.state !== 'normal') return hourAngle;

  const signedHourAngle = isSunrise
    ? radiansToDegrees(hourAngle.radians)
    : -radiansToDegrees(hourAngle.radians);
  let minutes =
    720 - 4 * (longitude + signedHourAngle) - coordinates.equationOfTime;

  coordinates = solarCoordinates(julianDate + minutes / 1440);
  hourAngle = solarHourAngle(latitude, coordinates.declinationRadians);
  if (!hourAngle || hourAngle.state !== 'normal') return hourAngle;

  const refinedSignedHourAngle = isSunrise
    ? radiansToDegrees(hourAngle.radians)
    : -radiansToDegrees(hourAngle.radians);
  minutes =
    720 - 4 * (longitude + refinedSignedHourAngle) - coordinates.equationOfTime;

  return Number.isFinite(minutes) ? { state: 'normal', minutes } : null;
}

function localDateParts(date) {
  if (date === null || date === undefined) return null;
  const parsed = date instanceof Date ? new Date(date.getTime()) : new Date(date);
  if (!Number.isFinite(parsed.getTime())) return null;
  return {
    year: parsed.getFullYear(),
    month: parsed.getMonth() + 1,
    day: parsed.getDate()
  };
}

function localDecimalHour(date) {
  return (
    date.getHours() +
    date.getMinutes() / 60 +
    date.getSeconds() / 3600 +
    date.getMilliseconds() / 3600000
  );
}

function localEventHour(parts, event) {
  if (event.state !== 'normal' || !Number.isFinite(event.minutes)) return null;

  const utcMidnight = Date.UTC(parts.year, parts.month - 1, parts.day);
  return localDecimalHour(new Date(utcMidnight + event.minutes * 60000));
}

function calculateCutoffs(date, latitude, longitude) {
  const parts = localDateParts(date);
  if (!parts) return null;

  const dateJulianDay = julianDay(parts.year, parts.month, parts.day);
  const sunrise = solarEventUtcMinutes(dateJulianDay, latitude, longitude, true);
  const sunset = solarEventUtcMinutes(dateJulianDay, latitude, longitude, false);
  if (!sunrise || !sunset) return null;

  if (sunrise.state === 'daylight' && sunset.state === 'daylight') {
    return { dayStartHour: 0, nightStartHour: 24 };
  }
  if (sunrise.state === 'darkness' && sunset.state === 'darkness') {
    return { dayStartHour: 0, nightStartHour: 0 };
  }

  let dayStartHour;
  let nightStartHour;
  if (sunrise.state === 'normal' && sunset.state === 'normal') {
    dayStartHour = localEventHour(parts, sunrise);
    nightStartHour = localEventHour(parts, sunset);
  } else if (sunrise.state === 'normal' && sunset.state === 'daylight') {
    dayStartHour = localEventHour(parts, sunrise);
    nightStartHour = 24;
  } else if (sunrise.state === 'daylight' && sunset.state === 'normal') {
    dayStartHour = 0;
    nightStartHour = localEventHour(parts, sunset);
  } else {
    return null;
  }

  if (
    !Number.isFinite(dayStartHour) ||
    !Number.isFinite(nightStartHour) ||
    dayStartHour >= nightStartHour
  ) {
    return null;
  }

  return { dayStartHour, nightStartHour };
}

export function purgeLegacySunCache(storage) {
  try {
    const target = storage ?? globalThis.localStorage;
    const keys = [];
    for (let index = 0; index < target.length; index++) {
      const key = target.key(index);
      if (key === LEGACY_CACHE_KEY || key?.startsWith(LEGACY_CACHE_PREFIX)) {
        keys.push(key);
      }
    }
    for (const key of keys) {
      target.removeItem(key);
    }
  } catch {
    // Blocked or unavailable storage must never interrupt drive logging.
  }
}

export function hasSunConfig(settings) {
  return (
    !!settings?.useAstronomicalSun &&
    Number.isFinite(settings.latitude) &&
    settings.latitude >= -90 &&
    settings.latitude <= 90 &&
    Number.isFinite(settings.longitude) &&
    settings.longitude >= -180 &&
    settings.longitude <= 180
  );
}

export async function getCutoffsForDate(date, settings) {
  const fallback = {
    dayStartHour: settings?.dayStartHour,
    nightStartHour: settings?.nightStartHour
  };

  if (!hasSunConfig(settings)) return fallback;

  return calculateCutoffs(date, settings.latitude, settings.longitude) ?? fallback;
}
