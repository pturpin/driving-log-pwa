// Per-device configuration: which AWS region/identity pool/table/driver
// this install talks to. Lives only in localStorage — deliberately not
// synced, since it's device identity, not logbook data.

const STORAGE_KEY = 'drivelog.config.v1';
const CODE_PREFIX = 'dlog1.';

/** @returns {{region:string, idp:string, table:string, driver:string}|null} */
export function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed.region || !parsed.idp || !parsed.table || !parsed.driver) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveConfig(config) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function clearConfig() {
  localStorage.removeItem(STORAGE_KEY);
}

/** Encode a config object into a shareable setup code. */
export function encodeSetupCode(config) {
  const json = JSON.stringify({
    region: config.region,
    idp: config.idp,
    table: config.table,
    driver: config.driver
  });
  const b64 = btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return CODE_PREFIX + b64;
}

/**
 * Decode a setup code pasted by the user.
 * @throws {Error} with a human-readable message if the code is invalid.
 */
export function decodeSetupCode(code) {
  const trimmed = (code || '').trim();
  if (!trimmed.startsWith(CODE_PREFIX)) {
    throw new Error('That doesn\'t look like a setup code (should start with "dlog1.").');
  }
  const b64 = trimmed
    .slice(CODE_PREFIX.length)
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);

  let json;
  try {
    json = decodeURIComponent(escape(atob(padded)));
  } catch {
    throw new Error('Setup code is corrupted — try copying it again.');
  }

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Setup code is corrupted — try copying it again.');
  }

  const { region, idp, table, driver } = parsed;
  if (!region || !idp || !table || !driver) {
    throw new Error('Setup code is missing required fields.');
  }
  return { region, idp, table, driver };
}
