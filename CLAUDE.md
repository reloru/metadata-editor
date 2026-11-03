# metadata-editor

Static web app (PWA) served by a Cloudflare Worker. Reads and edits metadata in MP3, WAV, AIFF, FLAC, Ogg Vorbis/Opus, M4A, MP4/MOV, JPEG, PNG, WebP, GIF, HEIC/AVIF and TIFF/DNG files entirely in the browser.

## Layout
- `public/` — the app. `index.html`, `app.css`, `app.js` (UI), `editor.js` (format-agnostic open/save), `fields.js` (field model), `bytes.js`, `text.js`, `genres.js` (ID3v1 genre table), `cbor.js`, `der.js` (X.509 / RFC 3161 reader for C2PA display), `c2pa.js`, `id3.js`, `mp3.js`, `riff.js`, `bmff.js`, `tiff.js` (EXIF reader, in-place GPS removal), `exifedit.js` (append-only EXIF writer: per-tag edit/add/remove, thumbnail removal), `xmpedit.js` (XMP property edit/add/remove by splicing changed ranges), `photoinfo.js` (synced caption/keywords/date taken across EXIF and XMP), `image.js` (JPEG/PNG/WebP), `flac.js`, `aiff.js`, `heif.js` (HEIC/AVIF view + in-place GPS removal), `ogg.js` (Vorbis/Opus comments), `tiffimg.js` (TIFF/DNG view + in-place GPS removal within the first 4 MB), `gif.js` (comments, XMP/ICC/app extensions; walks the file through a 1 MB window), `manifest.webmanifest`, icons.
- `src/worker.js` — serves `env.ASSETS`, adds CSP / nosniff / no-referrer headers.
- `test/` — `node --test`; synthetic fixtures built in `test/fixtures.js`. No real audio is committed.
- `tools/make-icons.js` — regenerates the PNG icons (`node tools/make-icons.js`).
- `wrangler.jsonc`, `.github/workflows/ci.yml` (tests on PR and push to main; deploy on push to main). The deploy job stamps the short commit ID into `BUILD` in `public/editor.js`; the page shows it under the file picker.

## Hard constraints
- All parsing and writing client-side. No uploads, no server processing, no network requests from the page. The Worker serves static assets only.
- Zero dependencies (runtime and dev). No npm packages, frameworks, or CDNs. Plain ES modules, HTML, CSS. Tests use `node:test`. package.json only for `"type": "module"` and scripts.
- Never read whole files into memory except the on-demand C2PA data-hash check. Read metadata regions with `Blob.slice().arrayBuffer()`. Build output as `new Blob([...newParts, file.slice(a, b)])` so payload bytes pass through untouched.
- Detect format by magic bytes, not extension.
- Ogg: comment edits are re-laced into the same number of header pages (audio pages untouched); edits that do not fit are refused rather than re-paginating the file (owner may choose otherwise).
- EXIF edits are append-only: changed IFDs/values go after the existing TIFF data, pointers are updated, replaced bytes are zeroed. Never rebuild a TIFF (MakerNote and thumbnail offsets can be absolute).
- HEIF items are addressed by absolute offsets (iloc): never change the meta box size. Edited EXIF goes into a new mdat at the end of the file, the item's iloc offset/length are patched in place, the old item is zeroed.
- JPEG with an MPF index: segments after the index must not change size (MPF offsets are relative to it); new segments go before it.
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
