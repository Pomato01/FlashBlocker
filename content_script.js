/**
 * content_script.js
 *
 * Chrome injects this file into every YouTube page. It has direct access
 * to the page's DOM — meaning it can find the <video> element, draw frames
 * to a canvas, and inject an overlay div over the video.
 *
 * This is the coordinator: it drives the frame capture loop, feeds data
 * to the Worker, and acts on what the Worker reports back.
 */

// --- Configuration (synced from user settings in popup) ---
let settings = {
  enabled: true,
  sensitivity: 'medium'  // 'low' | 'medium' | 'high'
};

// --- DOM references we need ---
let videoElement = null;
let overlayElement = null;
let canvas = null;
let ctx = null;
let worker = null;
let animationFrameId = null;
let overlayActive = false;
let overlayTimeout = null;

// How many ms to keep the overlay on screen after danger is detected.
// We keep it on briefly so fast flashes don't cause rapid flicker of the overlay itself.
const OVERLAY_HOLD_MS = 800;

// How often to analyze a frame (ms). 33ms ≈ 30fps.
// We don't need to analyze every single rendered frame — 30fps is plenty
// to catch flashes that happen at 3+ Hz.
const ANALYSIS_INTERVAL_MS = 33;
let lastAnalysisTime = 0;

// -------------------------------------------------------------------
// Initialization
// -------------------------------------------------------------------

/**
 * Load saved settings from Chrome's storage, then start watching for
 * a video element to appear. YouTube is a single-page app so the video
 * element may not exist yet when this script first runs.
 */
function init() {
  chrome.storage.sync.get({ enabled: true, sensitivity: 'medium' }, (stored) => {
    settings = stored;
    watchForVideo();
  });
}

/**
 * YouTube dynamically inserts and removes <video> elements as the user
 * navigates between pages (it's a React SPA). We use a MutationObserver
 * to detect when a video appears, rather than assuming it's already there.
 */
function watchForVideo() {
  // Check if there's already a video on the page
  const existing = document.querySelector('video');
  if (existing) {
    attachToVideo(existing);
    return;
  }

  // Otherwise watch for one to be added to the DOM
  const observer = new MutationObserver(() => {
    const video = document.querySelector('video');
    if (video) {
      observer.disconnect();
      attachToVideo(video);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// -------------------------------------------------------------------
// Attaching to the video element
// -------------------------------------------------------------------

/**
 * Once we have a video element, set up everything we need:
 * - A hidden canvas to capture frames
 * - An overlay div to dim dangerous content
 * - A Web Worker to run the analysis
 * - The animation frame loop
 */
function attachToVideo(video) {
  videoElement = video;

  // Create a hidden canvas the same size as the video.
  // We never display this canvas — it's just a scratchpad for pixel reading.
  canvas = document.createElement('canvas');
  canvas.width = 320;   // We down-sample to 320x180 — sufficient for brightness
  canvas.height = 180;  // analysis and much faster than native 1080p resolution
  canvas.style.display = 'none';
  document.body.appendChild(canvas);
  ctx = canvas.getContext('2d', { willReadFrequently: true });
  // willReadFrequently: true is a Chrome hint that tells the browser we'll be
  // calling getImageData() a lot — it optimizes internally for this access pattern.

  // Create the overlay div that sits over the video during dangerous content
  createOverlay();

  // Start the Web Worker
  worker = new Worker(chrome.runtime.getURL('analyzer.worker.js'));
  worker.onmessage = handleWorkerResult;

  // Begin the frame capture loop
  startLoop();

  // Listen for messages sent from popup.js
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'SETTINGS_UPDATE') {
      settings = message.settings;
      if (!settings.enabled) {
        deactivateOverlay();
        stopLoop();
      } else {
        startLoop();
      }
    }

    // Popup polls this every 300ms to show the live flash readout
    if (message.type === 'GET_STATS') {
      sendResponse({ flashesPerSecond: lastFlashesPerSecond, isDangerous: lastIsDangerous });
    }

    return true; // Keep the message channel open for async sendResponse
  });

  // If the user navigates to a new YouTube video (SPA navigation),
  // re-attach to the new video element
  video.addEventListener('emptied', () => {
    deactivateOverlay();
    watchForVideo();
  });
}

// -------------------------------------------------------------------
// Overlay
// -------------------------------------------------------------------

/**
 * Creates a full-screen overlay div positioned over the video element.
 * It starts hidden (opacity 0) and fades in when danger is detected.
 */
function createOverlay() {
  overlayElement = document.createElement('div');
  overlayElement.id = 'seizure-shield-overlay';

  // Position it on top of the video's parent container
  const videoContainer = videoElement.closest('.html5-video-container') || videoElement.parentElement;
  videoContainer.style.position = 'relative';
  videoContainer.appendChild(overlayElement);

  Object.assign(overlayElement.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    width: '100%',
    height: '100%',
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    zIndex: '9999',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    opacity: '0',
    transition: 'opacity 0.15s ease',
    pointerEvents: 'none',   // Lets clicks pass through when inactive
    fontFamily: 'sans-serif',
    color: '#ffffff',
    textAlign: 'center',
    gap: '12px'
  });

  // Warning message shown inside the overlay
  overlayElement.innerHTML = `
    <div style="font-size: 22px; font-weight: 600;">⚠ Flashing content detected</div>
    <div style="font-size: 14px; opacity: 0.75;">Video dimmed by SeizureShield</div>
    <button id="seizure-shield-dismiss"
      style="margin-top:8px; padding: 8px 20px; border-radius: 6px;
             background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.3);
             color: #fff; cursor: pointer; font-size: 13px;">
      Resume anyway
    </button>
  `;

  // Allow user to manually dismiss the overlay
  document.getElementById('seizure-shield-dismiss').addEventListener('click', (e) => {
    e.stopPropagation();
    manualDismiss();
  });
}

function activateOverlay() {
  if (overlayActive) return;
  overlayActive = true;
  overlayElement.style.opacity = '1';
  overlayElement.style.pointerEvents = 'auto';

  // Pause the video to give the user time to react
  if (videoElement && !videoElement.paused) {
    videoElement.pause();
  }
}

function deactivateOverlay() {
  overlayActive = false;
  if (overlayElement) {
    overlayElement.style.opacity = '0';
    overlayElement.style.pointerEvents = 'none';
  }
}

function manualDismiss() {
  deactivateOverlay();
  // Give a 3-second grace period where we suppress re-triggering,
  // so the user can actually watch the video they just unpaused.
  suppressUntil = Date.now() + 3000;
}

let suppressUntil = 0;
let lastFlashesPerSecond = 0;
let lastIsDangerous = false;

// -------------------------------------------------------------------
// Frame capture loop
// -------------------------------------------------------------------

function startLoop() {
  if (animationFrameId) return; // Already running
  loop();
}

function stopLoop() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

/**
 * The main loop. Runs on requestAnimationFrame — meaning it fires in sync
 * with the browser's render cycle (up to ~60fps). We throttle our actual
 * analysis to every ANALYSIS_INTERVAL_MS (33ms = ~30fps) so we don't
 * over-analyze.
 */
function loop(timestamp = 0) {
  animationFrameId = requestAnimationFrame(loop);

  if (!settings.enabled) return;
  if (!videoElement || videoElement.paused || videoElement.ended) return;
  if (timestamp - lastAnalysisTime < ANALYSIS_INTERVAL_MS) return;
  lastAnalysisTime = timestamp;

  // Draw the current video frame onto our small canvas
  try {
    ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
  } catch (e) {
    // Cross-origin errors can happen with some YouTube embeds — skip this frame
    return;
  }

  // Read all pixel data from the canvas
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  // Send the raw pixel data to the Worker.
  // We transfer the underlying ArrayBuffer rather than copying it (the {transfer} option)
  // — this is significantly faster for large arrays.
  worker.postMessage(
    { pixels: imageData.data, width: canvas.width, height: canvas.height, timestamp },
    [imageData.data.buffer]
  );
}

// -------------------------------------------------------------------
// Handling worker results
// -------------------------------------------------------------------

/**
 * The Worker sends back { isDangerous, flashesPerSecond, luminance }
 * every time it finishes analyzing a frame.
 */
function handleWorkerResult({ data }) {
  const { isDangerous, flashesPerSecond } = data;

  lastFlashesPerSecond = flashesPerSecond;
  lastIsDangerous = isDangerous;

  if (isDangerous && Date.now() > suppressUntil) {
    activateOverlay();

    // Clear any existing auto-dismiss timer and set a new one
    if (overlayTimeout) clearTimeout(overlayTimeout);
    overlayTimeout = setTimeout(() => {
      // Only auto-dismiss if the flashing has stopped
      // (isDangerous will be false if the worker calms down)
    }, OVERLAY_HOLD_MS);
  } else if (!isDangerous && overlayActive) {
    // Flashing has calmed down — schedule overlay dismissal
    if (!overlayTimeout) {
      overlayTimeout = setTimeout(() => {
        deactivateOverlay();
        overlayTimeout = null;
      }, OVERLAY_HOLD_MS);
    }
  }
}

// -------------------------------------------------------------------
// Kick everything off
// -------------------------------------------------------------------
init();
