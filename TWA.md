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

## 4) Verify endpoint

With server running, open:

- `/.well-known/assetlinks.json`

The file must be reachable over HTTPS on your production domain.

## 5) Bubblewrap (outside repo scope)

Typical flow:

1. Install bubblewrap globally.
2. Init project from `twa-manifest.json`.
3. Build Android App Bundle (`.aab`).
4. Publish internal test track.


The repo-side prerequisites are now in place:

- explicit server route for `/.well-known/assetlinks.json`
- generated assetlinks support
- baseline readiness check script
