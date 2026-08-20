# FlashShield for YouTube

A Chrome extension that automatically detects and dims flashing content on YouTube, built for photosensitive people.

Detection is based on the [WCAG 2.1 Three Flashes or Below Threshold](https://www.w3.org/WAI/WCAG21/Understanding/three-flashes-or-below-threshold.html) standard.

---

## File structure

```
flash-blocker/
├── manifest.json          # Extension config (permissions, entry points)
├── content_script.js      # Runs inside YouTube — captures frames, drives overlay
├── background.js          # Service Worker — runs flash detection analytics off the main thread
├── popup.html             # Settings popup UI
├── popup.js               # Settings popup logic
├── icons/
│   ├── FlashBlockerIconPadded-2.png
│   ├── FlashBlockerIconPadded-1.png
│   └── FlashBlockerIconPadded.png
└── README.md
```

---

## How the files interact

```
popup.html / popup.js
│
│ chrome.storage (read/write sensitivity settings)
│ chrome.storage.onChanged (real-time updates)
▼
content_script.js ─── chrome.runtime.sendMessage(ANALYZE_FRAME) ──▶ background.js
│ │
│ processFrameStats
│ │
◀──────────────────── sendResponse(isDangerous) ─────────────────┘
│
▼
overlay div (injected into YouTube page)
```

### `manifest.json`

Tells Chrome what the extension is allowed to do. Grants permission to access YouTube pages and Chrome storage. Declares which JS files run where.

### `content_script.js`

The coordinator. Chrome injects it into every YouTube tab. It:

- Waits for a `<video>` element to appear (YouTube is an SPA so this isn't instant)
- Sets up a hidden canvas to capture video frames
- Calculates WCAG relative luminance across a $2 \times 2$ spatial grid to detect localized flashes without dropping frames
- Runs a `requestAnimationFrame` loop, drawing each frame to the canvas and reading pixel data
- Sends lightweight quadrant luminance stats to background.js via runtime messaging
- Receives signals back from the background.js and activates/deactivates the overlay
- Listens for settings messages from the popup

### `background.js`

The analysis engine and state manager. Running as a service worker, it:

- Recieves spatial frame metrics asynchronously off the main thread to eliminate frame drops and page lag
- Evaluates frame-to-frame luminance deltas across each quadrant to prevent spatial cancellation errors
- maintains 1 second rolling timestamp window to track flash frequencies
- listens to chrome.storage.sync and syncs setting changes across extension components

### `popup.html` + `popup.js`

The settings UI that appears when you click the extension icon. It:

- Loads/saves settings via `chrome.storage.sync` (persists across sessions)
- Broadcasts setting changes to the active tab's content script immediately
- Polls the content script every 300ms to show a live flash-rate readout

---

## Installing locally (for development)

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `flash-blocker/` folder

You'll need to add placeholder icon images in `icons/` before Chrome will load the extension (any 16×16, 48×48, and 128×128 PNG files work for development).

---

## Known limitations & next steps

- **Sensitivity thresholds are simplified.** The WCAG standard also factors in the screen area covered by the flash (must be >25% of screen). This version uses luminance delta only
- **YouTube Shorts** use a different DOM structure than regular videos. The `querySelector('video')` approach may need adjustment for Shorts.
- **No red-flash detection.** WCAG flags rapid red transitions separately from general luminance flashes. This is not yet implemented.
- **SPA navigation** (clicking between videos) is handled but may miss edge cases on some YouTube page types.

---

## References

- [WCAG 2.1 — Three Flashes or Below Threshold](https://www.w3.org/WAI/WCAG21/Understanding/three-flashes-or-below-threshold.html)
- [ITU-R BT.709 — Luminance formula](https://www.itu.int/rec/R-REC-BT.709/)
- [Chrome Extensions — Manifest V3](https://developer.chrome.com/docs/extensions/mv3/intro/)
- [Canvas API — getImageData](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/getImageData)
- [Web Workers API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API)
