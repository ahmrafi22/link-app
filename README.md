# Link Vault — mobile app

Local-first capture inbox for [the Link Vault plan](../PLAN.md) (Phase 2, local-only stage). Share a link from **any** app — X, Instagram, YouTube, your browser — tap **Link Vault** in the share sheet, and it is stored on-device and listed here. No server, no accounts, no other services yet.

## What it does

- **Share-sheet capture** — Android intent filter (`ACTION_SEND`, `text/*`) and an iOS share extension (web URL + text), both wired by the `expo-share-intent` config plugin. The app opens, the link lands in the list.
- **Local storage only** — items persist in AsyncStorage. Everything works offline.
- **Deduplication** — URLs are normalized (scheme/host lowercased, `utm_*`, `fbclid`, `igsh`, YouTube `si`, X `s`, etc. stripped) and re-shares bump a `×N` counter instead of creating a second entry, matching the plan's `seen_count` model.
- **Links and notes** — a share with only text (no URL) is saved as a note; captions shared with a link are kept with it.
- **Search, open, copy, delete** — tap a row to open the link in an in-app browser tab; long-press for copy/open/delete.
- **Manual paste** — the input at the top doubles as the quick-capture form (and is the capture surface on web via `npm run web`).

## Running it (no Android Studio needed)

> The share target cannot run in **Expo Go** — the share extension/intent filters are native code compiled into the app binary, and Expo Go is a fixed pre-built binary. A one-time cloud-built dev client replaces Expo Go (and replaces any local Android SDK install).

Prerequisites: Node 24, npm, a free Expo account, and an Android phone (the share-sheet flow needs a real phone anyway).

One-time setup — build the dev client in Expo's cloud and install it on your phone:

```bash
npm install
npx eas login                      # free account at expo.dev
npm run build:dev                  # EAS cloud build (~15–20 min on the free tier)
```

When the build finishes, the terminal shows a QR code / link — open it on the phone and install the APK (allow "install unknown apps" when prompted).

Day-to-day development after that — live reload from your PC, no more builds:

```bash
npm start                          # phone and PC on the same Wi-Fi (or: npx expo start --tunnel)
```

Open **Link Vault** on the phone — it connects to Metro from your PC and hot-reloads JS changes. Native config changes (app.json/plugins) are the only thing that needs another `npm run build:dev`.

Testing the share target: open any app with a link (X, YouTube, browser…), tap **Share**, pick **Link Vault**, and the item appears in the list. Sharing the same link twice bumps the `×N` badge.

`npm run build:apk` builds a standalone APK (no Metro connection) if you want to install it somewhere without the dev server.

## CI: APK from GitHub, no local Android SDK

Every push to `master`/`main` runs [.github/workflows/build-apk.yml](.github/workflows/build-apk.yml): GitHub's runner installs deps, runs `expo prebuild` (the `/android` folder is gitignored, so CI regenerates it), builds a **standalone release APK** (JS bundled, signed with the template's auto-generated debug keystore — fine for sideloading, no Metro or dev server needed) and publishes it two ways:

- **Releases** (the one to use) — `github.com/<you>/<repo>/releases` → newest `build-N` at the top → tap the `.apk` in the phone browser and install. Never expires, no login needed on a public repo.
- **Workflow artifacts** — repo Actions tab → the run → artifacts. Zipped, expires after ~90 days; use Releases instead.

No secrets or Expo account needed. To trigger a build without a push: Actions tab → "Build Android APK" → Run workflow. First build is slow (~15–20 min); later ones are faster thanks to the Gradle cache. Debug-signed is fine for sideloading; a release-signed build can be added later with a keystore secret.

## Project layout

```
src/app/_layout.tsx   # RootLayout: ShareIntentProvider + themed Stack
src/app/index.tsx     # Inbox screen: share handling, list, search, paste input
src/lib/store.ts      # item types, URL normalization/dedupe, AsyncStorage CRUD, useVault()
src/lib/theme.ts      # light/dark palette
scripts/make-icons.mjs# regenerates assets/images icon set (npm run icons)
```

Data is a single JSON array under AsyncStorage key `linkvault.items.v1`. When the backend phases land (per PLAN.md), this store is the seam to replace with API sync + offline queue.
