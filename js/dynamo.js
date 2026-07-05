// Talks to DynamoDB directly from the browser using short-lived Cognito
// guest credentials — no custom backend, no long-lived secret shipped
// in this bundle.
//
// Loaded from esm.sh as ES modules. If you'd rather self-host these
// (e.g. no external CDN allowed on your network), download the same
// packages and adjust these three import URLs to point at your own copy.

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand
} from 'https://esm.sh/@aws-sdk/client-dynamodb@3?bundle';
import { fromCognitoIdentityPool } from 'https://esm.sh/@aws-sdk/credential-provider-cognito-identity@3?bundle';
import { marshall, unmarshall } from 'https://esm.sh/@aws-sdk/util-dynamodb@3?bundle';

let cachedClient = null;
let cachedConfigKey = null;

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

/** Default shape for a driver who has no item yet. */
function emptyItem(driverId) {
  return {
    driverId,
    version: 0,
    active: null,
    sessions: [],
    settings: {
      goalTotalHours: 50,
      goalNightHours: 10,
      dayStartHour: 6,
      nightStartHour: 20
    }
  };
}

/** Read the current item for this device's driver, or a fresh default if none exists. */
export async function readItem(config) {
  const client = getClient(config);
  const res = await client.send(
    new GetItemCommand({
      TableName: config.table,
      Key: marshall({ driverId: config.driver })
    })
  );
  return res.Item ? unmarshall(res.Item) : emptyItem(config.driver);
}

/**
 * Read-modify-write with optimistic concurrency.
 * `mutator(currentItem)` receives a full current item (never mutate it in
 * place — return a new object) and should return the new item, EXCLUDING
 * `version` (that's managed here).
 *
 * Retries automatically if another device wrote in between.
 */
export async function updateItem(config, mutator, maxRetries = 3) {
  const client = getClient(config);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const current = await readItem(config);
    const draft = await mutator(current);
    const nextVersion = (current.version || 0) + 1;
    const newItem = { ...draft, driverId: config.driver, version: nextVersion };

    const isNew = current.version === 0 && current.sessions.length === 0 && !current.active;

    try {
      await client.send(
        new PutItemCommand({
          TableName: config.table,
          Item: marshall(newItem, { removeUndefinedValues: true }),
          ConditionExpression: isNew
            ? 'attribute_not_exists(driverId)'
            : 'version = :expected',
          ExpressionAttributeValues: isNew
            ? undefined
            : marshall({ ':expected': current.version })
        })
      );
      return newItem;
    } catch (err) {
      const isConditionFailure =
        err?.name === 'ConditionalCheckFailedException' ||
        err?.__type?.includes('ConditionalCheckFailedException');
      if (isConditionFailure && attempt < maxRetries) {
        // Someone else wrote first — small backoff, then re-read and retry.
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Could not save — too many conflicting writes. Try again.');
}
