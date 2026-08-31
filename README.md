# Driving Log PWA

A static, no-build GitHub Pages app for a shared supervised-driving logbook.
The app uses browser IndexedDB for offline-first durability and conditionally
writes one versioned document per driver directly to DynamoDB through Cognito
guest credentials.

## Offline-first behavior

- After one successful setup/sync, the installed app opens from its service
  worker cache, displays the last logbook, and accepts entry and active-drive
  changes without network service.
- Sessions, the shared active drive, pending entity changes, conflicts,
  acknowledgements, device identity, and the last five confirmed remote
  snapshots are stored in IndexedDB.
- Sync runs on launch, when the browser reports an `online` event, when the
  user taps **Sync**, and every 30 seconds while the app is open. Background
  Sync is deliberately not required because browser support is inconsistent.
- Settings and full disaster restore are online-only and require zero pending
  local records. A concrete DynamoDB request, not only `navigator.onLine`,
  determines whether the operation succeeds.
- The header reports **offline**, **pending N**, **syncing**,
  **needs attention**, or **synced**. Pending data is never silently discarded.

On iPhone/iPad, use **Share → Add to Home Screen**. Safari may evict
script-writable storage for sites that are not installed and have not been
used for an extended period. The app requests persistent storage after a
successful sync and shows whether the browser granted it, but current JSON
backups remain important.

## Conflict behavior

The local effective log is always the last confirmed remote snapshot overlaid
with local dirty entities. Conditional whole-document writes are serialized by
a per-driver single-flight sync worker. Disjoint changes rebase automatically;
same-entry edits/deletes and incompatible shared active-drive changes remain
local until resolved.

Stopping a drive (new session plus active clear) and merging entries (new
session plus source tombstones) use atomic local groups and never partially
commit. An uncertain write is considered applied only when the remote entity
matches the expected local revision and this installation's `updatedBy`
identity. A matching whole-document version alone is not proof.

Explicit intervals conflict when `a.start < b.end && b.start < a.end`.
Touching endpoints and duration-only entries are excluded. Entries whose start
and end are each within five minutes are shown as likely duplicates; duplicate
classification takes precedence over overlap. Migration-baseline overlaps are
acknowledged from document metadata on every installation.

## Data safety and schema

Current remote documents use schema version 2 and include:

- top-level `schemaVersion`, `minimumClientVersion`, `migratedAt`, and
  `deletedSessions`;
- stable session IDs, explicit/duration time kind, timestamps, revision, and
  device authorship;
- stable shared-active ID, revision, and device authorship.

Legacy documents are conditionally migrated once using top-level
`schemaVersion`. A current client repairs metadata removed by a stale legacy
client without rerunning whole-document migration or resurrecting tombstones.
The update-required gate blocks new current-client commands when the remote
minimum version is newer, while preserving display, export, and pending data.
Already-cached legacy clients cannot be stopped server-side under the retained
direct-browser architecture.

Remote DynamoDB data and backup JSON are treated as attacker-controlled.
Prototype keys are removed, model fields are copied through strict allowlists,
invalid records are quarantined visibly, and untrusted values are rendered
only through DOM `textContent`/safe attributes. Printing constructs a separate
document with DOM APIs. Connection codes are validated before persistence.

## Backups and recovery

- **Download backup** exports versioned schema metadata, live sessions,
  settings, active state, and tombstones. AWS region, identity-pool ID, table
  name, and setup codes are never exported.
- **Restore from backup** validates and previews creates/changes/deletions,
  then queues them as normal local changes. Unnamed current entries remain.
- **Recover from local snapshot history** previews one of the last five
  confirmed remote snapshots as safe local changes.
- **Full disaster restore** is a separate confirmation-heavy online operation.
  It requires no dirty records, uses a conditional write, and clears local
  dirty/conflict/acknowledgement state only after the remote write is confirmed.

The app warns at 250 KB because DynamoDB has a 400 KB item limit. Tombstones
also consume item capacity. Export a backup before the warning approaches the
limit; archival is intentionally outside this release.

## AWS setup

1. Create an on-demand DynamoDB table with a String partition key named
   `driverId`.
2. Create a Cognito Identity Pool with unauthenticated identities enabled.
3. Restrict its unauthenticated IAM role to `dynamodb:GetItem` and
   `dynamodb:PutItem` on only this table.
4. On the first device, enter region, identity-pool ID, table, and driver name.
5. For another device, enter its driver name and tap **Copy setup code**.
   Share the code only over a trusted channel.

### Accepted architectural risk

A setup code is a bearer capability. Anyone who obtains it receives the same
direct table access granted by the Cognito unauthenticated role. The static
client cannot enforce per-user authorization, stop malicious writers, or make
remote state authoritative against an attacker. Strict validation, conditional
writes, random IDs, and local snapshot history reduce damage but do not fix
authorization. An authenticated API is the future remediation.

## Static hosting and local validation

Deploy the entire repository to GitHub Pages (or another HTTPS static host).
There is no package manager, build step, backend, or production bundler.

For local testing:

```sh
python3 -m http.server 8080
```

Open `http://localhost:8080/`, then
`http://localhost:8080/tests/`. The browser assertion page exercises migration,
repair, quarantine, setup-code validation, dirty projection, rebase and atomic
groups, uncertain-write authorship, overlap/duplicate rules, backup preview,
DOM-safe rendering, vendor integrity, and the complete active shell cache.

Manual release checks should cover:

1. initial online setup and sync;
2. installed cold offline launch, entry create/edit/delete, start/stop;
3. reconnect and manual Sync, including a deliberately interrupted write;
4. two-device same-entry, active, overlap, and duplicate resolution;
5. update available while dirty (refresh must be gated);
6. legacy metadata damage repair and tombstone preservation;
7. normal import, snapshot recovery, and guarded full restore;
8. Android Chromium and iOS Safari installed-app behavior.

## Vendored AWS SDK

`js/vendor/aws-sdk.js` is a self-contained browser ESM bundle generated from
exact official npm registry artifacts. It has no remote imports or runtime
dependency fetches. `js/vendor/MANIFEST.md` records every source package's exact version,
registry tarball, integrity value, and the shipped bundle SHA-256. Every
vendored file is listed explicitly in `sw.js` `SHELL_ASSETS`.
