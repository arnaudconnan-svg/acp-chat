# TWA quickstart (Android)

This repo is now pre-wired for Android Digital Asset Links.

## 1) Baseline check

Run:

```bash
npm run twa:check
```

## 2) Signing key setup (auto)

Generates a local development keystore, extracts SHA256, and creates `assetlinks.json`:

```bash
npm run twa:signing-key
```

This is fully automated and outputs the fingerprint for your records.

## 3) Generate TWA manifest (domain switch ready)

Generate a `twa-manifest.json` that can target either current or future domain.

Current host (`acp-chat-beta.onrender.com`):

```bash
npm run twa:manifest
```

Future host (`facilitat.io`):

```bash
$env:TWA_WEB_HOST="facilitat.io"
npm run twa:manifest
```

Only `TWA_WEB_HOST` changes when switching domain.

## 4) Generate Android project (Bubblewrap)

Initialize the Android project structure:

```bash
npm run twa:build
```

This:
- Installs bubblewrap globally (if needed)
- Generates `android-project/` with all build files
- Creates build configuration from `twa-manifest.json`

## 5) Build Android App Bundle

```bash
cd android-project
bubblewrap build
```

Output: `dist/*.aab` (ready for Play Store internal test track)

## 6) Verify endpoint (before deployment)

With server running, verify:

```
https://acp-chat-beta.onrender.com/.well-known/assetlinks.json
```

Must be reachable over HTTPS on your production domain.

## 7) Upload to Play Store

1. Create/sign in to Google Play Console
2. Create new app (package: `io.facilitat.app`)
3. Upload `.aab` to internal test track
4. Test on device
5. Promote to production when ready



The repo-side prerequisites are now in place:

- explicit server route for `/.well-known/assetlinks.json`
- generated assetlinks support
- baseline readiness check script
