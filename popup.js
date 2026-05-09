/**
 * popup.js
 *
 * Controls the popup window that appears when the user clicks the extension icon.
 * Responsibilities:
 *   1. Load saved settings from Chrome storage and reflect them in the UI
 *   2. Save changes back to storage and notify the content script immediately
 *   3. Poll the content script for live flash data to show in the readout
 */

// --- Element references ---
const enableToggle  = document.getElementById('enable-toggle');
const statusDot     = document.getElementById('status-dot');
const statusText    = document.getElementById('status-text');
const bodyContent   = document.getElementById('body-content');
const flashCount    = document.getElementById('flash-count');
const flashStatus   = document.getElementById('flash-status');
const flashBar      = document.getElementById('flash-bar');
const pills         = document.querySelectorAll('.pill');

// Current settings object (kept in sync with storage)
let currentSettings = { enabled: true, sensitivity: 'medium' };

// -------------------------------------------------------------------
// Load settings on popup open
// -------------------------------------------------------------------

chrome.storage.sync.get({ enabled: true, sensitivity: 'medium' }, (stored) => {
  currentSettings = stored;
  applySettingsToUI(stored);
});

// -------------------------------------------------------------------
// UI → Storage → Content script
// -------------------------------------------------------------------

enableToggle.addEventListener('change', () => {
  currentSettings.enabled = enableToggle.checked;
  saveAndBroadcast();
  updateStatusUI();
});

pills.forEach(pill => {
  pill.addEventListener('click', () => {
    pills.forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    currentSettings.sensitivity = pill.dataset.value;
    saveAndBroadcast();
  });
});

/**
 * Save current settings to Chrome's sync storage (so they persist across
 * browser sessions and sync across devices if the user is signed into Chrome),
 * then send a message to the content script so it can apply the new settings
 * immediately without needing a page reload.
 */
function saveAndBroadcast() {
  chrome.storage.sync.set(currentSettings);

  // Send to the active YouTube tab's content script
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'SETTINGS_UPDATE',
        settings: currentSettings
      });
    }
  });
}

// -------------------------------------------------------------------
// Apply loaded settings to the UI elements
// -------------------------------------------------------------------

function applySettingsToUI(settings) {
  enableToggle.checked = settings.enabled;

  pills.forEach(p => {
    p.classList.toggle('active', p.dataset.value === settings.sensitivity);
  });

  updateStatusUI();
}

function updateStatusUI() {
  const on = currentSettings.enabled;
  statusDot.classList.toggle('off', !on);
  statusText.textContent = on ? 'Monitoring' : 'Paused';
  bodyContent.classList.toggle('disabled', !on);
}

// -------------------------------------------------------------------
// Live readout — poll the content script for flash data
// -------------------------------------------------------------------

/**
 * Every 300ms, ask the content script for the current flash rate.
 * The content script responds with { flashesPerSecond, isDangerous }.
 * We display this in the readout panel.
 *
 * Note: This only works when a YouTube video tab is active. If the
 * content script isn't loaded (e.g. on a non-video page), the message
 * will fail silently via the catch.
 */
function pollLiveData() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;

    chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_STATS' }, (response) => {
      // chrome.runtime.lastError fires if there's no listener — suppress it
      if (chrome.runtime.lastError) return;
      if (!response) return;

      updateReadout(response.flashesPerSecond, response.isDangerous);
    });
  });
}

function updateReadout(fps, isDangerous) {
  flashCount.textContent = fps !== undefined ? fps.toFixed(1) : '—';

  // Bar width: 0% at 0 flashes/sec, 100% at 6+ flashes/sec
  const barPct = Math.min((fps / 6) * 100, 100);
  flashBar.style.width = barPct + '%';
  flashBar.style.background = isDangerous ? '#ff6b6b' : '#5cd9a5';

  if (isDangerous) {
    flashStatus.textContent = 'Dangerous';
    flashStatus.className = 'readout-value danger';
    flashCount.className = 'readout-value danger';
  } else {
    flashStatus.textContent = 'Safe';
    flashStatus.className = 'readout-value safe';
    flashCount.className = 'readout-value';
  }
}

// Start polling immediately and repeat every 300ms while popup is open
pollLiveData();
const pollInterval = setInterval(pollLiveData, 300);

// Clean up when popup closes
window.addEventListener('unload', () => clearInterval(pollInterval));
