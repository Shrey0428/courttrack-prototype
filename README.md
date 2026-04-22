# CourtTrack Prototype — Delhi Case-Status Edition

This runnable prototype now treats the **official Delhi High Court case-wise status flow** as the primary lookup path, with a manual CAPTCHA step handled in two stages.

## What it can do

- track demo cases with `mockHighCourt`
- run an **official Delhi case-status lookup** with `delhiManualCaptcha`
  - `POST /lookup/start` opens the official Delhi page in Playwright, fills the case fields, captures the CAPTCHA, and stores the browser session server-side
  - `POST /lookup/complete` accepts `sessionId` and `captchaText`, submits the official lookup, parses the result, and closes the Playwright session
- configure one or more per-case reminder emails and send daily upcoming-hearing reminders from D-3 through D-0
- open each tracked case on its own details page with documents, events, sync runs, and reminder history
- protect the dashboard behind a login page backed by a server-side session
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

Login defaults to `admin` / `courttrack123` unless you set:

```bash
APP_LOGIN_USERNAME=your-login
APP_LOGIN_PASSWORD=your-password
```

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
- `POST /api/reminders/run`
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
APP_LOGIN_USERNAME=your-login
APP_LOGIN_PASSWORD=your-password
```

The reminder worker checks tracked cases on a timer and sends one email per day when a hearing is 3, 2, 1, or 0 days away.

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
