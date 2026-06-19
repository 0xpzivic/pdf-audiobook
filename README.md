# PDF Audiobook

A tiny, offline-first **PWA** that reads PDF books out loud. Built for personal use on an iPhone 14.

- Pick a PDF from your phone, press play, it reads aloud.
- **Remembers where you stopped** — even after closing the app or rebooting.
- **Skip forward / back** by sentence, or scrub to any position.
- **Speed control** (0.5× – 2.0×).
- **2 voices** (Samantha + Alex, the built-in iOS voices — no downloads).
- Works **fully offline** once added to your Home Screen. No server, no account.

## How it works

- `pdf.js` extracts the text from the PDF **on your device**.
- The browser's `SpeechSynthesis` API speaks it using the iOS system voices.
- Your book (the PDF + extracted sentences), position, speed and voice are stored in **IndexedDB** on the phone.
- A **service worker** caches the whole app so it launches offline.

> Note: The PDF must have a real text layer. Scanned/image-only PDFs (no selectable text) can't be read without OCR, which this app doesn't do.

## Install on iPhone (one time, online)

1. Open the app URL in **Safari** (the published GitHub Pages link).
2. Tap the **Share** icon (square with up arrow) at the bottom.
3. Scroll down and tap **Add to Home Screen** → **Add**.
4. Launch it from the Home Screen icon. From now on it runs offline like a native app.

The first launch needs internet so the service worker can cache `pdf.js`. After that, no connection is required.

## Controls

- **Play / Pause** — center button.
- **◀ / ▶** — jump one sentence back / forward.
- **Scrubber** — drag to any position in the book.
- **− / + (Speed)** — slower / faster.
- **Voice button** — tap to switch between the 2 voices.
- **Back (top-left)** — go to the upload screen (keeps your book & position).
- **Remove (top-right)** — delete the current book and its saved position.

## Run / develop locally

It's just static files. Serve the folder with any static server:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

(Service workers require http(s), not `file://`.)

## Files

- `index.html` / `styles.css` / `app.js` — the app.
- `sw.js` — service worker (offline caching).
- `manifest.json` — PWA manifest.
- `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` — icons.
- `gen_icons.py` — regenerates the icons (stdlib only).
