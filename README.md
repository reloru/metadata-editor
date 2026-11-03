# metadata-editor

Edit metadata in MP3 (ID3v2.3/2.4), WAV (LIST/INFO, id3 chunk), AIFF/AIFC (text chunks, ID3 chunk), FLAC (Vorbis comments, pictures), Ogg Vorbis and Opus (comments, edited within the existing header pages), M4A, MP4 and MOV (iTunes ilst), JPEG, PNG and HEIC/AVIF files on-device. Images: view EXIF/XMP/ICC/C2PA, remove GPS location without touching other EXIF, edit JPEG comments and PNG text chunks, delete metadata blocks. HEIC/AVIF: view EXIF/XMP, remove GPS in place. MOV/MP4: QuickTime keys metadata shown (make, model, creation date, location) and location (keys, udta ©xyz, 3GPP loci) removable. Nothing is uploaded: files are parsed and rewritten in the browser, and payload bytes are copied through untouched. Multi-value tags are edited one value per line. Shows C2PA manifests (read-only: claim details, signer and timestamp as claimed, with an on-demand data-hash check and a remove option) and Suno provenance strings compared against the manifest times. Technical details include MP3 VBR/CBR, average bitrate and gapless delay/padding. Installable as a PWA.

- Test: `node --test`
- Deploy: CI deploys on push to `main` (`npx wrangler@4 deploy`, needs repo secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`).

Not yet supported (rejected with a message): WebP, GIF, Ogg FLAC/Speex/Theora, RF64. Out of scope: documents and archives, fragmented-MP4 editing, ID3v1/APEv2 editing, timed-text remux, C2PA signature/certificate validation.
