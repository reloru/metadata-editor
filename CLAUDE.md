# metadata-editor

Static web app (PWA) served by a Cloudflare Worker. Reads and edits metadata in MP3, WAV, M4A and MP4 files entirely in the browser.

## Layout
- `public/` — the app. `index.html`, `app.css`, `app.js` (UI), `editor.js` (format-agnostic open/save), `fields.js` (field model), `bytes.js`, `text.js`, `cbor.js`, `c2pa.js`, `id3.js`, `mp3.js`, `riff.js`, `bmff.js`, `manifest.webmanifest`, icons.
- `src/worker.js` — serves `env.ASSETS`, adds CSP / nosniff / no-referrer headers.
- `test/` — `node --test`; synthetic fixtures built in `test/fixtures.js`. No real audio is committed.
- `tools/make-icons.js` — regenerates the PNG icons (`node tools/make-icons.js`).
- `wrangler.jsonc`, `.github/workflows/ci.yml` (tests on PR and push to main; deploy on push to main).

## Hard constraints
- All parsing and writing client-side. No uploads, no server processing, no network requests from the page. The Worker serves static assets only.
- Zero dependencies (runtime and dev). No npm packages, frameworks, or CDNs. Plain ES modules, HTML, CSS. Tests use `node:test`. package.json only for `"type": "module"` and scripts.
- Never read whole files into memory except the on-demand C2PA data-hash check. Read metadata regions with `Blob.slice().arrayBuffer()`. Build output as `new Blob([...newParts, file.slice(a, b)])` so payload bytes pass through untouched.
- Detect format by magic bytes, not extension.
- The owner works only from an iPhone. Target mobile Safari first.
- Read current Cloudflare/wrangler docs before writing config; don't guess keys. Cloudflare credentials are in env: never print, log, or commit them.

## Pull requests
- Full autonomy from branch through merge. Single human participant; no reviewers.
- Don't block on CI; poll. On a failing check: read the log, fix, push.
- Before merging, confirm the branch fully addresses its purpose. Ask first only if a judgment call was made that the owner might decide differently.
- Report only the merge and final state.

## Commands the owner must run
Single-line, typed on a phone.

## On context compaction
Finish the current unit, leave the branch in a stated condition, write `HANDOFF.md` (done / in flight / remaining / key files), stop.
