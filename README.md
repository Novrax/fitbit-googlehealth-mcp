# fitbit-googlehealth-mcp

> A **Model Context Protocol (MCP) server** for your Google Health data (Fitbit's successor). Reads your health metrics and writes food, weight, activity and sleep logs. TypeScript, deployed to Cloudflare Workers, connected to Claude Desktop / mobile / claude.ai as a custom connector.

Built for single-user personal use: fork it and run it on your own Google Cloud project and Cloudflare account.

---

## Status — read this first

The legacy **Fitbit Web API (`api.fitbit.com`) is being decommissioned in September 2026**, and Google is no longer issuing new Fitbit developer accounts. This server therefore targets the **Google Health API** (`health.googleapis.com/v4`) by default.

| | |
|---|---|
| **Default backend** | Google Health API v4 (`HEALTH_PROVIDER=google`) |
| **Legacy backend** | Fitbit Web API, still present behind `HEALTH_PROVIDER=fitbit`, on borrowed time |
| **Written against** | v4 discovery document, revision **20260909** |

Verified against live Google Health data on 2026-09-10: all 17 read methods return real
values from a Fitbit Air. `pnpm run verify:provider` re-runs that check against your own
account, and `pnpm run probe:google` dumps the raw API shapes if you need to debug a
specific data type.

---

## What it does

- **Read** (16 tools) — activity and steps, heart rate (daily + intraday), sleep with stages, weight and body fat, food and water logs, SpO2, respiratory rate, skin temperature, HRV, VO2 max, paired devices.
- **Write** (7 tools) — food, water, weight, body fat, activity and sleep logs.
- **Delete** (6 tools) — remove individual entries.
- **Meal presets** (4 tools) — reusable nutrition profiles stored in Workers KV.
- **⭐ `log_meal_photo`** — attach a meal photo in Claude, Claude estimates the nutrition visually, and the items are written to your food log in one call.

---

## Prerequisites

- A **Google account** holding your health data (a Fitbit account merged into Google).
- A **Google Cloud project** with the Google Health API enabled — free.
- A **Cloudflare account** — the free plan is enough.
- A **Claude account** — custom connectors must be added from claude.ai on the web, then sync to mobile.
- **Node.js 20+** and **pnpm 9+** locally.

You do **not** need a Fitbit developer account. If you already made one, it is only useful for the legacy `HEALTH_PROVIDER=fitbit` path, which stops working this month.

---

## Setup

### 1. Clone and install

```bash
git clone <your-fork-url>
cd fitbit-googlehealth-mcp
pnpm install
```

### 2. Create the Google Cloud project

1. **Create or pick a project** — https://console.cloud.google.com/projectcreate
2. **Enable the Google Health API** — https://console.cloud.google.com/apis/api/health.googleapis.com
3. **Configure the OAuth consent screen** — https://console.cloud.google.com/auth/audience
   - User type: **External**
   - Add your own Google account under **Test users**
   - **Publish the app so its status is "In production".** This matters: while the app sits in *Testing*, Google expires refresh tokens after **7 days**, and the Worker will break every week. Publishing does *not* require Google's security review — that is only needed above 100 users.
4. **Add the scopes** — https://console.cloud.google.com/auth/scopes — search "Google Health API" and add read and write for activity & fitness, health metrics & measurements, sleep and nutrition, plus profile and settings (read).
5. **Create an OAuth client ID** — https://console.cloud.google.com/apis/credentials
   - Application type: **Desktop app**
   - Copy the **Client ID** and **Client secret**

### 3. Authorize

Copy the template and paste your two values into it:

```bash
cp .env.example .env      # macOS / Linux / Git Bash
copy .env.example .env    # Windows cmd / PowerShell
```

```ini
# .env
GOOGLE_CLIENT_ID=1234567890-abc123.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-your-secret-here
```

No quotes, no trailing spaces. `.env` is gitignored. Then:

```bash
pnpm run setup:google
```

Your browser opens Google's consent screen. Approve it, and the script prints the exact `wrangler` commands for the next step.

<details>
<summary>Prefer environment variables to a file?</summary>

The script reads real environment variables first, so these work too — the syntax just differs per shell:

```powershell
# PowerShell
$env:GOOGLE_CLIENT_ID = "..."
$env:GOOGLE_CLIENT_SECRET = "..."
```
```bash
# bash / zsh / Git Bash
export GOOGLE_CLIENT_ID=...
export GOOGLE_CLIENT_SECRET=...
```
```bat
:: Windows cmd
set GOOGLE_CLIENT_ID=...
set GOOGLE_CLIENT_SECRET=...
```
</details>

Consent is collected here, in a real browser, on purpose: Google blocks OAuth inside embedded WebViews (`disallowed_useragent`), which is what Claude mobile would use.

### 4. Push to Cloudflare

```bash
cp wrangler.toml.example wrangler.toml
# then check TIMEZONE in wrangler.toml — it decides what "today" means for
# every tool with an optional date. Ships as "Europe/London".

pnpm wrangler kv namespace create TOKENS
pnpm wrangler kv namespace create CACHE
# paste the returned ids into wrangler.toml

pnpm wrangler secret put GOOGLE_CLIENT_ID
pnpm wrangler secret put GOOGLE_CLIENT_SECRET
openssl rand -hex 32 | pnpm wrangler secret put MCP_SHARED_SECRET

# tokens — copy the exact commands printed by setup:google (--remote matters)
pnpm wrangler kv key put --remote --binding=TOKENS google_refresh_token '<paste>'
pnpm wrangler kv key put --remote --binding=TOKENS google_access_token  '<paste>'
pnpm wrangler kv key put --remote --binding=TOKENS google_expires_at    '<paste>'
```

### 5. Deploy

```bash
pnpm deploy
# → https://fitbit-googlehealth-mcp.<your-subdomain>.workers.dev
```

### 6. Add to Claude

1. On [claude.ai](https://claude.ai): Settings → Connectors → **Add custom connector**
2. URL: `https://fitbit-googlehealth-mcp.<your-subdomain>.workers.dev/mcp/<MCP_SHARED_SECRET>`
3. Authentication: **none** — the secret is already in the URL path
4. Save; it syncs to Claude Desktop and mobile automatically

New connectors cannot be added from Claude mobile — use the web.

---

## Where secrets live

Three separate places, for three separate purposes. This trips people up, so:

| Purpose | Where | How it gets there |
|---|---|---|
| Running the local helper scripts (`setup:google`, `probe:google`) | `.env` in the repo root | You create it from `.env.example`. Gitignored. |
| The **deployed** Worker on Cloudflare | Cloudflare Workers Secrets | `pnpm wrangler secret put GOOGLE_CLIENT_ID` — encrypted at rest, never in the repo |
| Running the Worker locally with `pnpm dev` | `.dev.vars` in the repo root | You create it. Gitignored. |

The deployed Worker **never reads `.env`** — Cloudflare doesn't upload it. If you skip
`wrangler secret put`, the Worker deploys fine and then fails at runtime with a
`GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set` error.

Your Google **refresh token** is not in any of these. It lives in the Workers KV `TOKENS`
namespace, put there by the `wrangler kv key put` commands in step 4.

## Verifying

```bash
# easiest: paste the access token setup:google printed into .env as
#   GOOGLE_ACCESS_TOKEN=ya29...
pnpm run probe:google

# or pass it inline (bash / Git Bash)
GOOGLE_ACCESS_TOKEN=ya29... pnpm run probe:google

# or against the token the deployed Worker is using
GOOGLE_ACCESS_TOKEN=$(pnpm wrangler kv key get --remote --binding=TOKENS google_access_token) \
  pnpm run probe:google
```

The probe is read-only. For each endpoint it prints `✓` with the value fields that came back, `·` if reachable but empty, or `✗` with the API's error. A `403` means that scope was not granted — add it on the Data Access page and re-run `setup:google`.

To check the provider itself rather than the raw API — that every read method returns
sensible values, not `undefined` from a wrong field path:

```bash
pnpm run verify:provider
```

It calls all 17 read methods against your live account and prints a preview of each
result. Read-only; it never writes or deletes. Access tokens last about an hour, so
refresh `GOOGLE_ACCESS_TOKEN` in `.env` if it starts returning 401.

---

## Tools

### Read (16)

| Tool | Arguments | Notes |
|---|---|---|
| `get_profile` | — | Identity, units, timezone |
| `list_devices` | — | Paired devices, battery, last sync |
| `get_daily_summary` | `date?` | Steps, calories, distance, active minutes, resting HR |
| `get_activity_timeseries` | `resource, start, end` | steps / distance / calories / floors / active-minute levels |
| `get_exercise_list` | `beforeDate?, limit?` | Workout sessions |
| `get_heart_rate_range` | `start, end` | Daily resting heart rate |
| `get_heart_rate_intraday` | `date, detailLevel` | Down-sampled from raw samples |
| `get_sleep` | `date?` | Sessions with stage breakdown |
| `get_sleep_range` | `start, end` | |
| `get_body_log` | `start, end` | Weight and body fat |
| `get_food_log` | `date?` | Food and water with macros |
| `get_spo2` | `start, end` | |
| `get_respiratory_rate` | `start, end` | |
| `get_skin_temperature` | `start, end` | Deviation from baseline |
| `get_hrv` | `start, end` | |
| `get_cardio_fitness` | `date?` | VO2 max |

### Write (7)

`log_food` · `log_meal_photo` · `log_water` · `log_weight` · `log_body_fat` · `log_activity` · `log_sleep`

### Delete (6)

`delete_food_log` · `delete_water_log` · `delete_weight_log` · `delete_body_fat_log` · `delete_activity_log` · `delete_sleep_log`

### Meal presets (4)

`save_meal_preset` · `list_meal_presets` · `log_preset` · `delete_meal_preset`

33 tools total. Every optional `date` falls back to today.

---

## Architecture

```
Claude mobile / Desktop / Web
      │ (public URL, Streamable HTTP)
      ▼
Anthropic Cloud  (outbound CIDR 160.79.104.0/21)
      │
      ▼
Cloudflare Workers  /mcp/<SECRET>
  ├─ guard middleware  (SECRET + CIDR allowlist)
  ├─ @hono/mcp  Streamable HTTP transport
  └─ McpServer
       ├─ HealthProvider interface
       │   ├─ GoogleHealthProvider   ← default
       │   │   ├─ Google OAuth refresh (Workers KV: TOKENS)
       │   │   └─ GoogleHealthClient (pagination, 401/429 retry)
       │   └─ FitbitProvider          ← legacy, sunsetting
       └─ tools/read/*, tools/write/*
            └─ getCached → Workers KV: CACHE  (TTL 1h)
```

Images never reach the server: Claude analyses the photo and passes structured `items[]`.

---

## Notes on the Google Health API

Things that differ from Fitbit and cost time if you hit them cold:

- **Every `int64` field is serialised as a string.** `{"count": "1250"}`, not `1250`.
- **Filter literals differ by time field.** Civil (wall-clock) times take **no** `Z`; physical instants **require** one; daily types take a bare `YYYY-MM-DD`.
- **Ranges are closed-open.** The API supports only `>=` and `<`, so an inclusive end date has to be advanced by a day.
- **`sleep` filters on end time only** (`sleep.interval.civil_end_time`).
- **Rollups return `rollupDataPoints`**, not `dataPoints`, and paginate by re-POSTing the body with a `pageToken`.
- **`windowSizeDays` is documented as optional but is required** — omitting it returns HTTP 400.
- **Rollup ranges are capped**: 14 days for heart rate, total calories, active minutes and calories-in-HR-zone; 90 days for everything else.
- **List pages cap at 25 rows** for sleep and exercise, 10000 elsewhere.
- **No intraday detail levels.** Google exposes raw ~5-second samples; `get_heart_rate_intraday` down-samples client-side.
- **Skin temperature is absolute °C** plus a baseline; Fitbit reported only the deviation, so this server derives it.
- **Nutrient enum is `SUGAR`, singular.** Fat and carbohydrate are top-level `totalFat` / `totalCarbohydrate` fields, not `nutrients[]` entries.
- **Delete takes a resource name, not an id.** The numeric `logId` in these tools is a stable hash of that name, resolved by scanning the last 35 days.
- **A DataPoint nests its values under a camelCase key** named for the data type, so a
  `daily-resting-heart-rate` row arrives as `{dailyRestingHeartRate: {...}}`. Reading the
  top level typechecks fine and yields `undefined` for every field.
- **Rollup buckets are dated by `civilStartTime`,** not `date`.
- **`activity-level` supports neither rollup verb** — the periods must be listed and
  summed client-side.
- **`active-zone-minutes` rollups carry flat `sumIn<Zone>HeartZone` keys,** not an array
  of zone objects, and no zone bounds.
- **Instant-valued types are filtered in true UTC,** so selecting a local day means
  converting local midnight to UTC first — not using UTC midnight.

---

## Security

Single-user design, two layers:

1. The `<MCP_SHARED_SECRET>` at the end of the URL path must match (constant-time compare), or 401.
2. `CF-Connecting-IP` must fall inside `ALLOWED_CIDRS`, or 403. Anthropic's published outbound range is `160.79.104.0/21`.

`MCP_SHARED_SECRET` lives in Workers Secrets, never in code. Rotating it is `wrangler secret put` plus updating the URL in claude.ai; your Google tokens are unaffected.

**Threat model:** if the secret leaks *and* the attacker can reach you from inside Anthropic's CIDR, they can read your health data and write false entries. They cannot take over the Google account — the refresh token stays in the Worker.

---

## Local development

```bash
echo 'MCP_SHARED_SECRET=dev-secret' > .dev.vars
pnpm dev

pnpm lint
pnpm typecheck
pnpm test
```

---

## Development notes

- [`docs/research.md`](docs/research.md) — original design research (Japanese), including the Fitbit-era API findings
- [`docs/journal.md`](docs/journal.md) — development log (Japanese)
- [`scripts/probe-google-health.ts`](scripts/probe-google-health.ts) — ground-truth probe against the live API
- [`scripts/diagnose-food-log.ts`](scripts/diagnose-food-log.ts) — legacy Fitbit food-log reproducer

## Hosted pages

GitHub Pages serves the three URLs Google's OAuth consent screen requires:

| Field on the consent screen | URL |
|---|---|
| Application home page | `https://novrax.github.io/fitbit-googlehealth-mcp/` |
| Privacy policy link | `https://novrax.github.io/fitbit-googlehealth-mcp/privacy.html` |
| Terms of service link | `https://novrax.github.io/fitbit-googlehealth-mcp/terms.html` |

Add `github.io` under **Authorized domains** on the same screen. Sources are in
[`docs/`](docs/).

## Credits

Derived from [tachibanayu24/fitbit-googlehealth-mcp](https://github.com/tachibanayu24/fitbit-googlehealth-mcp)
(MIT), which implemented the original Fitbit Web API server. The Google Health API provider,
the timezone handling and the OAuth bootstrap for Google are additions.

## License

[MIT](LICENSE)
