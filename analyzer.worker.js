/**
 * analyzer.worker.js
 *
 * Runs in a Web Worker — completely separate from the main browser thread.
 * Receives raw pixel data from the content script, runs the flash detection
 * algorithm, and posts back a result. Because this is in a Worker, heavy
 * pixel math never freezes or slows down the YouTube page itself.
 */

// --- State the worker keeps between frames ---
let previousLuminance = null;   // Average brightness of the last frame
let flashTimestamps = [];       // When each "flash" occurred (ms timestamps)
const FLASH_WINDOW_MS = 1000;   // How far back we look (1 second)
const FLASH_THRESHOLD = 3;      // How many flashes per second = danger (WCAG)
const LUMINANCE_DELTA = 0.10;   // Min brightness change to count as a flash
                                // (0–1 scale; 0.10 ≈ 10% brightness swing)

/**
 * Listen for pixel data messages sent by content_script.js.
 * Each message looks like: { pixels: Uint8ClampedArray, width, height, timestamp }
 */
self.onmessage = function(event) {
  const { pixels, width, height, timestamp } = event.data;

  // Step 1: Calculate average luminance of this frame.
  // We sample every 4th pixel row and column (16x fewer pixels) for performance.
  const luminance = sampleLuminance(pixels, width, height);

  // Step 2: Compare to the previous frame.
  if (previousLuminance !== null) {
    const delta = Math.abs(luminance - previousLuminance);

    // A "flash" is a brightness swing large enough to be a real flash,
    // not just a scene cut or gradual change.
    if (delta > LUMINANCE_DELTA) {
      flashTimestamps.push(timestamp);
    }
  }

  previousLuminance = luminance;

  // Step 3: Remove timestamps older than 1 second.
  flashTimestamps = flashTimestamps.filter(t => timestamp - t < FLASH_WINDOW_MS);

  // Step 4: Count flashes in the last second and report back.
  const flashesPerSecond = flashTimestamps.length;
  const isDangerous = flashesPerSecond >= FLASH_THRESHOLD;

  self.postMessage({
    isDangerous,
    flashesPerSecond,
    luminance
  });
};

/**
 * Calculates the average perceived brightness of a frame.
 * Uses the standard luminance formula (ITU-R BT.709) which weights
 * green more heavily because human eyes are more sensitive to green.
 *
 * @param {Uint8ClampedArray} pixels - Raw RGBA pixel data from canvas
 * @param {number} width  - Frame width in pixels
 * @param {number} height - Frame height in pixels
 * @returns {number} Luminance value between 0 (black) and 1 (white)
 */
function sampleLuminance(pixels, width, height) {
  let total = 0;
  let count = 0;

  // Step every 4 rows and 4 columns to sample ~6% of pixels.
  // Fast enough for 30fps analysis; accurate enough to catch real flashes.
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const index = (y * width + x) * 4; // Each pixel is 4 bytes: R, G, B, A
      const r = pixels[index]     / 255;
      const g = pixels[index + 1] / 255;
      const b = pixels[index + 2] / 255;

      // ITU-R BT.709 weighted luminance
      total += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      count++;
    }
  }

  return count > 0 ? total / count : 0;
}
