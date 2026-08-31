import { safeJsonParse } from './utils.js';

const STORAGE_KEY = 'drivelog.config.v1';
const CODE_PREFIX = 'dlog1.';
const REGION_RE = /^[a-z0-9-]{1,32}$/;
const IDENTITY_POOL_RE = /^[a-z0-9-]+:[0-9a-f-]{36}$/;
const TABLE_RE = /^[A-Za-z0-9_.-]{3,255}$/;
const DRIVER_RE = /^[A-Za-z0-9 ._-]{1,64}$/;

export function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Configuration is invalid.');
  }
  const region = typeof input.region === 'string' ? input.region.trim() : '';
  const idp = typeof input.idp === 'string' ? input.idp.trim() : '';
  const table = typeof input.table === 'string' ? input.table.trim() : '';
  const driver = typeof input.driver === 'string' ? input.driver.trim() : '';
  if (!REGION_RE.test(region)) throw new Error('AWS region is invalid.');
  if (!IDENTITY_POOL_RE.test(idp)) throw new Error('Cognito Identity Pool ID is invalid.');
  if (!TABLE_RE.test(table)) throw new Error('DynamoDB table name is invalid.');
  if (!DRIVER_RE.test(driver)) throw new Error('Driver name is invalid.');
  return { region, idp, table, driver };
}

export function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return validateConfig(safeJsonParse(raw));
  } catch {
    return null;
  }
}

export function saveConfig(config) {
  const validated = validateConfig(config);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(validated));
  return validated;
}

export function clearConfig() {
  localStorage.removeItem(STORAGE_KEY);
}

export function encodeSetupCode(config) {
  const validated = validateConfig(config);
  const json = JSON.stringify(validated);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const b64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return CODE_PREFIX + b64;
}

export function decodeSetupCode(code) {
  const trimmed = typeof code === 'string' ? code.trim() : '';
  if (!trimmed.startsWith(CODE_PREFIX)) {
    throw new Error('That doesn\'t look like a setup code (should start with "dlog1.").');
  }
  const encoded = trimmed.slice(CODE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{8,4096}$/.test(encoded)) {
    throw new Error('Setup code is corrupted — try copying it again.');
  }
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  let parsed;
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    parsed = safeJsonParse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('Setup code is corrupted — try copying it again.');
  }
  return validateConfig(parsed);
}
