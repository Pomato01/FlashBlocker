/**
 * background.js
 * Runs as the Manifest V3 background service worker.
 * Processes lightweight spatial region stats off the main thread.
 */

let previousRegions = null;
let flashTimestamps = [];

let config = {
  flashWindowMs: 1000,
  flashThreshold: 3,
  luminanceDelta: 0.1,
};

// Initialize sensitivity settings from storage
chrome.storage.sync.get({ sensitivity: "medium" }, (stored) => {
  applySensitivity(stored.sensitivity);
});

// Watch for user settings updates from popup.html
chrome.storage.onChanged.addListener((changes) => {
  if (changes.sensitivity) {
    applySensitivity(changes.sensitivity.newValue);
  }
});

function applySensitivity(sensitivity) {
  switch (sensitivity) {
    case "high":
      config.luminanceDelta = 0.06;
      config.flashThreshold = 2;
      break;
    case "low":
      config.luminanceDelta = 0.15;
      config.flashThreshold = 4;
      break;
    case "medium":
    default:
      config.luminanceDelta = 0.1;
      config.flashThreshold = 3;
      break;
  }
}

// Listen for messages from content_script.js
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "ANALYZE_FRAME" && message.frameStats) {
    const result = processFrameStats(message.frameStats, message.timestamp);
    sendResponse(result);
  }
  return true; // Keep message channel open for async response
});

/**
 * Evaluates the 2x2 grid regions sent from content_script.js.
 * Triggers if any single region exceeds the luminance delta threshold.
 */
function processFrameStats(currentRegions, timestamp) {
  if (previousRegions !== null) {
    let flashDetected = false;

    // Check each quadrant (TL, TR, BL, BR) independently
    for (let i = 0; i < currentRegions.length; i++) {
      const regionDelta = Math.abs(currentRegions[i] - previousRegions[i]);

      // If any quadrant swings by >= threshold, count it as a flash event
      if (regionDelta >= config.luminanceDelta) {
        flashDetected = true;
        break; // One triggered quadrant in this frame frame is sufficient
      }
    }

    if (flashDetected) {
      flashTimestamps.push(timestamp);
    }
  }

  previousRegions = currentRegions;

  // Purge timestamps older than 1 second (1000ms)
  flashTimestamps = flashTimestamps.filter(
    (t) => timestamp - t < config.flashWindowMs,
  );

  const flashesPerSecond = flashTimestamps.length;
  const isDangerous = flashesPerSecond >= config.flashThreshold;

  return {
    isDangerous,
    flashesPerSecond,
    luminance: currentRegions[0], // Average luminance of top-left quadrant for telemetry
  };
}
