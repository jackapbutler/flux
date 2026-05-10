# Firebase Starter (React + Vite)

A tiny starter pack for Firebase Web:
- Firebase Auth (Google + email/password)
- Firestore (user profile + Strava workouts)
- Hosting + Functions (Gemini + Strava OAuth)
- Config via Vite env vars (`.env`)

## 1) Configure Firebase Auth

In the Firebase console:
1. **Authentication → Sign-in method**: enable **Google** and/or **Email/Password**
2. **Authentication → Settings → Authorized domains**: add:
   - `localhost` (local dev)
   - `YOUR_PROJECT_ID.web.app`
   - `YOUR_PROJECT_ID.firebaseapp.com`

If you see `auth/configuration-not-found` when clicking “Continue with Google”, it almost always means the **Google provider isn’t enabled** yet.

## 2) Configure Firestore

In the Firebase console:
1. **Firestore Database**: create a database

## 2) Set env vars

Copy `.env.example` → `.env` and fill values from Firebase Console → Project settings → Your apps → Web app.

> This repo includes a `.env` for your provided config, but `.env` is gitignored so you can safely customize per machine.

## 3) Run

```bash
npm install
npm run dev
```

Open http://localhost:5173

## Optional: Emulators

If you use the Firebase Emulator Suite, set:

```env
VITE_USE_EMULATORS=true
```

…and adjust host/ports in `.env` as needed.

## Gemini (callable Cloud Function)

This starter includes:
- `geminiPrompt` (callable): freeform prompt -> text
- `recommendNextWorkout` (callable): reads your goal + recent workouts and returns a calm next-workout plan

Gemini is called server-side so your API key is **not** exposed in the browser.

## Strava connect + sync

If “Sync Strava” fails with `internal`, check the full error message (it now includes Strava HTTP status/body) and verify `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET` are set as Functions secrets.

This repo includes:
- callable `stravaAuthUrl` (returns the Strava authorize URL)
- HTTPS endpoint `stravaCallback` at `/api/strava/callback`
- callable `stravaSyncRecent` (pulls last ~30 activities into Firestore)

You must create a Strava developer app and then set these Firebase Functions secrets:

```bash
firebase functions:secrets:set STRAVA_CLIENT_ID
firebase functions:secrets:set STRAVA_CLIENT_SECRET
firebase functions:secrets:set STRAVA_STATE_SECRET
```

Optionally set the Functions param `APP_BASE_URL` (only needed if you’re not using the default `https://<project>.web.app` domain):

```bash
firebase functions:params:set APP_BASE_URL "https://your-domain.example"
```

Setup:

```bash
npm install -g firebase-tools
firebase login
cd functions
npm install
cd ..
firebase functions:secrets:set GEMINI_API_KEY
```

For local dev:

1) Put a local-only Gemini key in `functions/.env` (this file is gitignored):

```env
GEMINI_API_KEY=YOUR_KEY
```

2) In one terminal, start emulators:

```bash
firebase emulators:start
```

3) In another terminal, set `VITE_USE_EMULATORS=true` in `.env`, then run:

```bash
npm run dev
```

## Deploy (Hosting + Firestore rules + Storage + Functions)

This repo includes `firebase.json`, `.firebaserc`, `firestore.rules`, `storage.rules`, and a `functions/` directory.

```bash
npm run build
npx -y firebase-tools@latest deploy --only firestore:rules,storage,functions,hosting
```

If you only changed Functions:

```bash
npx -y firebase-tools@latest deploy --only functions
```

## What to customize next

- Change the Firestore collection path (`users/<uid>/notes`) to match your app
- Add Firestore security rules matching your data model
- Add Storage, Functions, Messaging, etc.
