# Twin Tracker

Shared bottle + sleep tracker for twins (Rowan & Julian). Single-page PWA on
Firebase Firestore, hosted on Netlify (`resilient-hamster-e16eb5`).

## Repo layout
- `index.html`, `manifest.webmanifest`, `sw.js` — the app (deployed to Netlify).
- `backend/sender.js` — Node job that runs on a schedule via GitHub Actions:
  reads Firestore, sends web-push alerts, and imports SNOO sleep sessions.
- `backend/package.json` — backend dependencies (`web-push`).
- `.github/workflows/notify.yml` — cron + manual trigger for the backend job.

## Backend architecture
Firestore security rules are open (public read/write), so the backend reaches it
over the REST API with the public web API key — no service account needed.

The scheduled job (every 15 min) will:
1. Read `feedingLogs` / `napLogs` / `pushSubs`.
2. Evaluate alert conditions (baby awake too long, feed due) with throttling.
3. Send web-push notifications to stored subscriptions (VAPID).
4. Pull SNOO sessions from the Happiest Baby API and import new ones.

## Secrets (GitHub Actions → repo settings → Secrets)
- `VAPID_PRIVATE` — web-push private key (set).
- `VAPID_PUBLIC` — web-push public key (also embedded in the client).
- `VAPID_SUBJECT` — `mailto:` contact for VAPID.
- `SNOO_EMAIL`, `SNOO_PASSWORD` — Happiest Baby account (set by owner).

## Status
- Phase 1: installable PWA + service worker — DONE (live).
- Phase 2: push delivery — in progress.
- Phase 3: SNOO import — pending SNOO credentials.
