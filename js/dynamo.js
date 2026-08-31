import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  fromCognitoIdentityPool,
  marshall,
  unmarshall
} from './vendor/aws-sdk.js';
import {
  emptyDocument,
  SCHEMA_VERSION,
  normalizeRemoteDocument,
  serializeRemoteDocument,
  serializedByteLength,
  MAX_REMOTE_BYTES
} from './utils.js';

let cachedClient = null;
let cachedConfigKey = null;

const LOSSLESS_REPAIR_ISSUES = new Set([
  'legacy-active',
  'legacy-session-change',
  'missing-setting',
  'session-metadata-repair'
]);

export class ConditionalWriteError extends Error {
  constructor() {
    super('The shared log changed while saving.');
    this.name = 'ConditionalWriteError';
  }
}

function getClient(config) {
  const key = `${config.region}|${config.idp}`;
  if (cachedClient && cachedConfigKey === key) return cachedClient;
  cachedClient = new DynamoDBClient({
    region: config.region,
    credentials: fromCognitoIdentityPool({
      clientConfig: { region: config.region },
      identityPoolId: config.idp
    })
  });
  cachedConfigKey = key;
  return cachedClient;
}

function safeNetworkError(error, fallback) {
  if (error instanceof ConditionalWriteError) return error;
  const result = new Error(fallback);
  result.name = error?.name || 'RemoteError';
  result.retryable = true;
  return result;
}

async function getRawItem(config) {
  try {
    const response = await getClient(config).send(new GetItemCommand({
      TableName: config.table,
      Key: marshall({ driverId: config.driver })
    }));
    return response.Item ? unmarshall(response.Item) : null;
  } catch (error) {
    throw safeNetworkError(error, 'Could not reach the shared logbook.');
  }
}

export async function writeItem(config, document, expectedVersion, exists = true) {
  if (serializedByteLength(document) >= MAX_REMOTE_BYTES) {
    throw new Error('The shared logbook is too large for DynamoDB. Export a backup before making more changes.');
  }
  const next = {
    ...document,
    driverId: config.driver,
    version: expectedVersion + 1
  };
  const item = serializeRemoteDocument(next);
  const input = {
    TableName: config.table,
    Item: marshall(item, { removeUndefinedValues: true }),
    ConditionExpression: exists ? '#version = :expected' : 'attribute_not_exists(driverId)'
  };
  if (exists) {
    input.ExpressionAttributeNames = { '#version': 'version' };
    input.ExpressionAttributeValues = marshall({ ':expected': expectedVersion });
  }
  try {
    await getClient(config).send(new PutItemCommand(input));
    return next;
  } catch (error) {
    const isConditionFailure =
      error?.name === 'ConditionalCheckFailedException' ||
      String(error?.__type || '').includes('ConditionalCheckFailedException');
    if (isConditionFailure) throw new ConditionalWriteError();
    throw safeNetworkError(error, 'The shared logbook write did not receive a confirmed response.');
  }
}

export function isLosslessAutomaticRepair(normalized) {
  return normalized.changed &&
    normalized.document.quarantine.length === 0 &&
    normalized.issues.every((issue) => LOSSLESS_REPAIR_ISSUES.has(issue.code));
}

/**
 * Reads, validates, migrates, and repairs the remote document. Invalid records
 * are quarantined in the returned issue list and never persisted locally or
 * written back.
 */
export async function readItem(config, previous = null, maxRepairRetries = 2) {
  for (let attempt = 0; attempt <= maxRepairRetries; attempt++) {
    const raw = await getRawItem(config);
    if (!raw) {
      return {
        document: emptyDocument(config.driver),
        exists: false,
        issues: [],
        repaired: false,
        repairBlocked: false
      };
    }
    const normalized = normalizeRemoteDocument(raw, {
      driverId: config.driver,
      previous,
      now: new Date().toISOString()
    });
    if (normalized.document.schemaVersion > SCHEMA_VERSION ||
        normalized.issues.some((issue) => issue.code === 'invalid-version')) {
      return {
        document: normalized.document,
        exists: true,
        issues: normalized.issues,
        repaired: false,
        repairBlocked: normalized.changed
      };
    }
    if (!normalized.changed) {
      return {
        document: normalized.document,
        exists: true,
        issues: normalized.issues,
        repaired: false,
        repairBlocked: false
      };
    }
    if (!isLosslessAutomaticRepair(normalized)) {
      return {
        document: normalized.document,
        exists: true,
        issues: normalized.issues,
        repaired: false,
        repairBlocked: true
      };
    }
    try {
      const repaired = await writeItem(
        config,
        normalized.document,
        normalized.document.version,
        true
      );
      return {
        document: repaired,
        exists: true,
        issues: normalized.issues,
        repaired: true,
        repairBlocked: false
      };
    } catch (error) {
      if (error instanceof ConditionalWriteError && attempt < maxRepairRetries) continue;
      throw error;
    }
  }
  throw new Error('Could not repair the shared logbook after concurrent changes.');
}
