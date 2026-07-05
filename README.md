# Driving Log — PWA

Initial implementation matching `driving-log-pwa-spec.md`. Plain HTML/CSS/JS —
no build step, no framework, no server code to run.

## What's here

```
index.html          shell: setup gate + 4 screens (Home, Progress, Log, Settings)
manifest.json        PWA install metadata
sw.js                 minimal app-shell cache (never caches drive data)
css/app.css          dashboard visual design (dark, amber/indigo gauge)
js/app.js            UI logic, wiring, rendering
js/config.js          setup-code encode/decode, per-device local config
js/dynamo.js          DynamoDB read/write via Cognito guest credentials
js/utils.js            day/night split math, formatting helpers
js/export.js           print view, JSON backup/restore
icons/               placeholder app icons (swap for real artwork any time)
```

This matches the spec: shared table with per-driver partitions, connection-code
device setup (driver locked per device), manual entry, print export, JSON backup.

---

## 1. AWS setup (one-time, ~10 minutes)

### DynamoDB table
1. AWS Console → DynamoDB → **Create table**
2. Table name: `DrivingLog`
3. Partition key: `driverId` (String)
4. Billing mode: **On-demand** (this workload is tiny — on-demand avoids paying
   for provisioned capacity you don't use)
5. Everything else default. Create.

### Cognito Identity Pool (guest access)
1. Amazon Cognito → **Identity pools** → Create identity pool
2. Enable **"Allow unauthenticated identities"** — this is what lets the PWA
   get temporary AWS credentials with no login/signup flow
3. Name it (e.g. `drivelog-pool`) and create
4. Cognito auto-creates an IAM role for unauthenticated users, something like
   `Cognito_drivelogpoolUnauth_Role` — note its name
5. Note the **Identity Pool ID** shown after creation (format
   `us-east-1:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) — you'll paste this into
   the app later

### Lock down the IAM role
The unauthenticated role Cognito created has broad-ish defaults. Tighten it to
only touch this one table:

1. IAM → Roles → find the unauth role from the step above
2. Add an inline policy:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": ["dynamodb:GetItem", "dynamodb:PutItem"],
         "Resource": "arn:aws:dynamodb:REGION:ACCOUNT_ID:table/DrivingLog"
       }
     ]
   }
   ```
   Replace `REGION` and `ACCOUNT_ID` with your values (found on the DynamoDB
   table's "Overview" tab, in the ARN shown there).
3. Remove any other broad default policies attached to this role, if present.

This means a leaked setup code lets someone read/write this one table —
nothing else in your AWS account.

---

## 2. Hosting

Needs plain HTTPS static hosting — no server-side code involved. Any of these
work:

- **Netlify / Vercel free tier** — drag-and-drop this folder, done
- **S3 + CloudFront** — upload this folder to a bucket, serve via CloudFront
  for HTTPS
- **GitHub Pages** — push this folder to a repo, enable Pages

Whatever you pick, the whole folder (including `icons/`) needs to be
deployed together, at the same path structure.

**Local testing** (before deploying): `python3 -m http.server 8080` from
this folder, then visit `http://localhost:8080` — `localhost` is exempt
from the HTTPS requirement for service workers, so this works for testing
even though production needs real HTTPS.

---

## 3. First-run setup (per device)

**First device (whoever has the AWS values from step 1):**
1. Open the deployed URL
2. Tap **"First device? Enter AWS details manually"**
3. Fill in region, Identity Pool ID, table name (`DrivingLog`), and a driver
   name for this phone (e.g. `jamie`)
4. **Save & connect**

**Every other device:**
1. On the first device, go to **Settings → Other devices**, type the new
   driver's name, tap **Generate setup code**
2. Send that code (starts with `dlog1.`) via Signal or similar
3. On the new device, open the app, paste the code into **"Paste setup
   code"**, tap **Connect this device**

Each device is locked to one driver — there's no in-app driver switcher, by
design (see spec §8).

---

## 4. Notes on the AWS SDK dependency

`js/dynamo.js` imports the AWS SDK v3 (DynamoDB client, Cognito credential
provider, marshalling helpers) from `esm.sh` as ES modules — no bundler, no
`npm install`, works straight from a `<script type="module">`. If your
network policy doesn't allow loading from `esm.sh` at runtime, download the
same three packages (`@aws-sdk/client-dynamodb`, `@aws-sdk/credential-providers`,
`@aws-sdk/util-dynamodb`) as ESM builds and change the three import URLs at
the top of `js/dynamo.js` to point at your self-hosted copies — nothing else
in the app needs to change.

## 5. Known gaps in this initial pass

- **Icons** are simple generated placeholders matching the color system —
  swap `icons/icon-192.png` / `icons/icon-512.png` for real artwork whenever
  you like; sizes/paths already match the manifest.
- **iOS install nudge** isn't built yet — right now iPhone users need to
  know to use Share → Add to Home Screen themselves. Worth a small one-time
  in-app banner if that's a real gap for your household.
- **Offline write queue** isn't implemented — if a device is offline when
  Start/Stop is tapped, it'll show an error rather than queuing the action
  for later. Given this is home wifi/cell coverage for a driving log, likely
  a non-issue, but flagging it as a known limitation.
