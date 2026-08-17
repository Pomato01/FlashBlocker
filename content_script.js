let settings = { enabled: true, sensitivity: "medium" };

let videoElement = null;
let playerContainer = null;
let overlayElement = null;
let animationFrameId = null;
let overlayActive = false;
let overlayTimeout = null;

let offscreenCanvas = null;
let offscreenCtx = null;

const OVERLAY_HOLD_MS = 1000;
const ANALYSIS_INTERVAL_MS = 33; // ~30 FPS
let lastAnalysisTime = 0;
let suppressUntil = 0;

let lastFlashesPerSecond = 0;
let lastIsDangerous = false;

function init() {
  chrome.storage.sync.get(
    { enabled: true, sensitivity: "medium" },
    (stored) => {
      settings = stored;
      watchForVideo();
    },
  );

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) settings.enabled = changes.enabled.newValue;
    if (changes.sensitivity)
      settings.sensitivity = changes.sensitivity.newValue;

    if (!settings.enabled) {
      deactivateOverlay();
      stopLoop();
    } else {
      startLoop();
    }
  });
}

function watchForVideo() {
  const checkVideo = () => {
    const video = document.querySelector("video.html5-main-video");
    if (video && video !== videoElement) {
      attachToVideo(video);
    }
  };

  checkVideo();
  const observer = new MutationObserver(checkVideo);
  observer.observe(document.body, { childList: true, subtree: true });
}

function attachToVideo(video) {
  videoElement = video;
  playerContainer = video.closest(".html5-video-player") || video.parentElement;

  if (playerContainer) {
    playerContainer.style.position = "relative";
  }

  createOverlay();
  startLoop();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "GET_STATS") {
      sendResponse({
        flashesPerSecond: lastFlashesPerSecond,
        isDangerous: lastIsDangerous,
        enabled: settings.enabled,
      });
    }
    return true;
  });

  video.addEventListener("emptied", () => deactivateOverlay());
}

function createOverlay() {
  if (overlayElement) overlayElement.remove();

  overlayElement = document.createElement("div");
  overlayElement.id = "flash-shield-overlay";

  Object.assign(overlayElement.style, {
    position: "absolute",
    top: "0",
    left: "0",
    width: "100%",
    height: "100%",
    backgroundColor: "rgba(0, 0, 0, 0.92)",
    zIndex: "9999",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    opacity: "0",
    transition: "opacity 0.15s ease",
    pointerEvents: "none",
    fontFamily: "Roboto, Arial, sans-serif",
    color: "#ffffff",
    textAlign: "center",
    boxSizing: "border-box",
    padding: "20px",
  });

  overlayElement.innerHTML = `
    <div style="background: rgba(255, 68, 68, 0.2); border: 1px solid rgba(255, 68, 68, 0.5); padding: 8px 16px; border-radius: 20px; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: #ff6b6b; font-weight: 700; margin-bottom: 12px;">
      Safety Warning
    </div>
    <div style="font-size: 20px; font-weight: 600; margin-bottom: 6px;">Flashing Content Suppressed</div>
    <div style="font-size: 13px; opacity: 0.8; max-width: 360px; line-height: 1.4; margin-bottom: 16px;">
      Video dimmed due to rapid light or brightness changes.
    </div>
    <button id="flash-shield-dismiss" style="padding: 10px 24px; border-radius: 18px; background: #ffffff; border: none; color: #000000; font-weight: 600; cursor: pointer; font-size: 13px;">
      Resume Video
    </button>
  `;

  if (playerContainer) {
    playerContainer.appendChild(overlayElement);
  }

  overlayElement
    .querySelector("#flash-shield-dismiss")
    .addEventListener("click", (e) => {
      e.stopPropagation();
      manualDismiss();
    });
}

function activateOverlay() {
  if (overlayActive) return;
  overlayActive = true;
  overlayElement.style.opacity = "1";
  overlayElement.style.pointerEvents = "auto";

  if (videoElement && !videoElement.paused) {
    videoElement.pause();
  }
}

function deactivateOverlay() {
  overlayActive = false;
  if (overlayElement) {
    overlayElement.style.opacity = "0";
    overlayElement.style.pointerEvents = "none";
  }
}

function manualDismiss() {
  deactivateOverlay();
  suppressUntil = Date.now() + 4000;
  if (videoElement && videoElement.paused) {
    videoElement.play();
  }
}

function startLoop() {
  if (animationFrameId) return;
  loop();
}

function stopLoop() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

async function loop(timestamp = 0) {
  animationFrameId = requestAnimationFrame(loop);

  if (
    !settings.enabled ||
    !videoElement ||
    videoElement.paused ||
    videoElement.ended
  )
    return;
  if (timestamp - lastAnalysisTime < ANALYSIS_INTERVAL_MS) return;
  lastAnalysisTime = timestamp;

  try {
    const width = 80; // 80x45 resolution is lightweight and accurate for flash detection
    const height = 45;

    if (!offscreenCanvas) {
      offscreenCanvas = document.createElement("canvas");
      offscreenCanvas.width = width;
      offscreenCanvas.height = height;
      offscreenCtx = offscreenCanvas.getContext("2d", {
        willReadFrequently: true,
      });
    }

    offscreenCtx.drawImage(videoElement, 0, 0, width, height);
    const imageData = offscreenCtx.getImageData(0, 0, width, height);

    // Compute frame stats locally (instantaneous, lightweight math)
    const frameStats = computeFrameStats(imageData.data, width, height);

    // Send a tiny 16-byte payload to the background script
    chrome.runtime.sendMessage(
      {
        type: "ANALYZE_FRAME",
        frameStats,
        timestamp,
      },
      (response) => {
        if (chrome.runtime.lastError || !response) return;
        handleAnalysisResult(response);
      },
    );
  } catch (e) {
    // Cross-origin element protection skip
  }
}

/**
 * Calculates average WCAG relative luminance & RGB on a tiny frame sample.
 */
function computeFrameStats(pixels, width, height) {
  const halfWidth = Math.floor(width / 2);
  const halfHeight = Math.floor(height / 2);

  // Luminance sums and pixel counts for 4 quadrants: [TL, TR, BL, BR]
  const regionLuminance = [0, 0, 0, 0];
  const regionCounts = [0, 0, 0, 0];

  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const idx = (y * width + x) * 4;

      // Determine quadrant (0 = Top-Left, 1 = Top-Right, 2 = Bottom-Left, 3 = Bottom-Right)
      const quadrant = (y < halfHeight ? 0 : 2) + (x < halfWidth ? 0 : 1);

      const r = pixels[idx] / 255;
      const g = pixels[idx + 1] / 255;
      const b = pixels[idx + 2] / 255;

      const R = r <= 0.04045 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
      const G = g <= 0.04045 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
      const B = b <= 0.04045 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);

      regionLuminance[quadrant] += 0.2126 * R + 0.7152 * G + 0.0722 * B;
      regionCounts[quadrant]++;
    }
  }

  // Return an array of 4 region luminance values
  return regionLuminance.map((sum, i) => sum / (regionCounts[i] || 1));
}
function handleAnalysisResult(result) {
  const { isDangerous, flashesPerSecond } = result;

  lastFlashesPerSecond = flashesPerSecond;
  lastIsDangerous = isDangerous;

  if (isDangerous && Date.now() > suppressUntil) {
    activateOverlay();
    if (overlayTimeout) clearTimeout(overlayTimeout);
  } else if (!isDangerous && overlayActive) {
    if (!overlayTimeout) {
      overlayTimeout = setTimeout(() => {
        deactivateOverlay();
        overlayTimeout = null;
      }, OVERLAY_HOLD_MS);
    }
  }
}

init();
