# CourtTrack Prototype — Delhi Case-Status Edition

This runnable prototype now treats the **official Delhi High Court case-wise status flow** as the primary lookup path, with a manual CAPTCHA step handled in two stages.

## What it can do

- track demo cases with `mockHighCourt`
- run an **official Delhi case-status lookup** with `delhiManualCaptcha`
  - `POST /lookup/start` opens the official Delhi page in Playwright, fills the case fields, captures the CAPTCHA, and stores the browser session server-side
  - `POST /lookup/complete` accepts `sessionId` and `captchaText`, submits the official lookup, parses the result, and closes the Playwright session
- configure one or more per-case reminder emails and send daily upcoming-hearing reminders from D-3 through D-0
- prefer the latest-order hearing date when the order PDF can be parsed confidently, while still showing every possible date found in the order
- open the matching Delhi case-history page and extract filing/listing history during lookups
- run an **official district/taluka court eCourts CNR lookup** with `districtCourtCnr`
  - enter a 16-character CNR, solve the eCourts CAPTCHA, and parse current status, hearing history, filings, and orders
- customize reminder days per case and force-send a reminder for a case when needed
- open each tracked case on its own details page with documents, events, sync runs, and reminder history
- protect the dashboard behind a login page backed by server-side sessions and optional multi-user accounts
- keep `delhiCauseList` only as an optional secondary provider
- save snapshots, events, and scrape logs

## Important limitation

The `delhiManualCaptcha` provider is **semi-automatic** by design:
- it relies on the official Delhi site
- the official site requires a human-solved CAPTCHA
- auto-sync skips these manual-CAPTCHA cases

## Setup

```bash
npm install
npx playwright install
npm start
```

Open:

```text
http://localhost:3000
```

## Deploying online

This app is best deployed as a Dockerized Node service because it uses Playwright.

Included deployment files:

- `Dockerfile`
- `.dockerignore`
- `railway.json`

Recommended hosted env vars:

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-email@example.com
SMTP_PASS=your-app-password
SMTP_FROM="CourtTrack <your-email@example.com>"
SMTP_REPLY_TO=your-email@example.com
DEFAULT_REMINDER_EMAIL=info@amitguptaadvocate.com
APP_LOGIN_USERNAME=admin
APP_LOGIN_PASSWORD=change-this-password
# Prefer APP_USERS_JSON for multiple users. Password hashes can be generated with:
# node -e "console.log(require('./src/authService').createPasswordHash('new-password'))"
# APP_USERS_JSON='[{"username":"admin","displayName":"Admin","role":"admin","passwordHash":"pbkdf2$sha256$..."}]'
DB_PATH=/app/data/db.json
```

If you deploy on Railway, mount a persistent volume to `/app/data` so the JSON database survives restarts.

Login defaults to `admin` / `courttrack123` unless you set:

```bash
APP_LOGIN_USERNAME=your-login
APP_LOGIN_PASSWORD=your-password
```

For multiple users, set `APP_USERS_JSON` to an array of user objects with `username`, optional `displayName`/`role`, and a `passwordHash`. The legacy single-login variables remain as a fallback for local prototypes.

## Recommended first test

Use the **Delhi case-status lookup** section and enter:
- case type: `W.P.(C)`
- case number: `171`
- year: `2026`

Then:
1. click **Load CAPTCHA**
2. type the CAPTCHA shown from the official page
3. click **Submit CAPTCHA**

## Primary routes

- `POST /lookup/start`
- `POST /lookup/complete`
- `PATCH /api/cases/:id/reminders`
- `POST /api/reminders/run` with optional `caseId` and `forceSend`
- `GET /api/reminders/status`

## Reminder email setup

Set these env vars before starting the app if you want reminder emails to send:

```bash
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-user
SMTP_PASS=your-password
SMTP_FROM="CourtTrack <alerts@example.com>"
SMTP_REPLY_TO=optional-reply-to@example.com
DEFAULT_REMINDER_EMAIL=info@amitguptaadvocate.com
APP_LOGIN_USERNAME=your-login
APP_LOGIN_PASSWORD=your-password
```

The reminder worker checks tracked cases on a timer and sends one email per selected day-before value for each case. The default is 3, 2, 1, and 0 days away.

Optional:

```bash
REMINDER_INTERVAL_MS=3600000
AUTO_SYNC_MS=60000
```

## Key files

- `src/providers/delhiManualCaptcha.js`
- `src/reminderService.js`
- `src/providers/delhiCaseStatusSelectors.js`
- `src/sessionStore.js`
- `public/case.html`

## Notes

This is still a prototype. The Delhi court page structure may change, and the parser may need selector updates over time.
