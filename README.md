# metadata-editor

Edit metadata in MP3 (ID3v2.3/2.4), WAV (LIST/INFO, id3 chunk), M4A and MP4 (iTunes ilst) files on-device. Nothing is uploaded: files are parsed and rewritten in the browser, and payload bytes are copied through untouched. Shows C2PA manifests (read-only, with an on-demand data-hash check and a remove option) and Suno provenance strings. Installable as a PWA.

- Test: `node --test`
- Deploy: CI deploys on push to `main` (`npx wrangler@4 deploy`, needs repo secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`).

Out of scope: FLAC, OGG, AIFF, RF64, fragmented-MP4 editing, ID3v1/APEv2 editing, timed-text remux, C2PA signature/certificate validation.
