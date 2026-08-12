/**
 * analyzer.worker.js
 * Worker logic using OffscreenCanvas and WCAG 2.1 Relative Luminance calculation.
 */

let offscreenCanvas = null;
let offscreenCtx = null;

let previousLuminance = null;
let flashTimestamps = [];

let config = {
  flashWindowMs: 1000,
  flashThreshold: 3, // WCAG 2.1 general flash threshold
  luminanceDelta: 0.1,
};

self.onmessage = function (event) {
  const { type, settings, bitmap, timestamp } = event.data;

  if (type === "UPDATE_SETTINGS" && settings) {
    applySensitivity(settings.sensitivity);
    return;
  }

  if (type === "ANALYZE_FRAME" && bitmap) {
    analyzeFrame(bitmap, timestamp);
  }
};

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

function analyzeFrame(bitmap, timestamp) {
  const width = bitmap.width;
  const height = bitmap.height;

  if (!offscreenCanvas) {
    offscreenCanvas = new OffscreenCanvas(width, height);
    offscreenCtx = offscreenCanvas.getContext("2d", {
      willReadFrequently: true,
    });
  }

  offscreenCtx.drawImage(bitmap, 0, 0);
  bitmap.close(); // Free bitmap memory immediately

  const imageData = offscreenCtx.getImageData(0, 0, width, height);
  const luminance = calculateRelativeLuminance(imageData.data, width, height);

  if (previousLuminance !== null) {
    const delta = Math.abs(luminance - previousLuminance);
    if (delta >= config.luminanceDelta) {
      flashTimestamps.push(timestamp);
    }
  }

  previousLuminance = luminance;
  flashTimestamps = flashTimestamps.filter(
    (t) => timestamp - t < config.flashWindowMs,
  );

  const flashesPerSecond = flashTimestamps.length;
  const isDangerous = flashesPerSecond >= config.flashThreshold;

  self.postMessage({
    isDangerous,
    flashesPerSecond,
    luminance,
  });
}

/**
 * Calculates WCAG 2.1 Relative Luminance (sRGB -> Linear conversion)
 */
function calculateRelativeLuminance(pixels, width, height) {
  let totalLuminance = 0;
  let sampleCount = 0;

  // Subsample every 2nd pixel row and column
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const idx = (y * width + x) * 4;

      const r = pixels[idx] / 255;
      const g = pixels[idx + 1] / 255;
      const b = pixels[idx + 2] / 255;

      // Linearize sRGB channel components
      const R = r <= 0.04045 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
      const G = g <= 0.04045 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
      const B = b <= 0.04045 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);

      // ITU-R BT.709 linear weights
      totalLuminance += 0.2126 * R + 0.7152 * G + 0.0722 * B;
      sampleCount++;
    }
  }

  return sampleCount > 0 ? totalLuminance / sampleCount : 0;
}
