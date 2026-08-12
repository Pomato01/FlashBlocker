/**
 * popup.js
 * Synchronizes user configurations and displays real-time frame telemetry.
 */

document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.getElementById("enabled-toggle");
  const sensitivitySelect = document.getElementById("sensitivity-select");
  const flashCountEl = document.getElementById("flash-count");
  const statusBadge = document.getElementById("status-badge");

  chrome.storage.sync.get(
    { enabled: true, sensitivity: "medium" },
    (settings) => {
      toggle.checked = settings.enabled;
      sensitivitySelect.value = settings.sensitivity;
    },
  );

  toggle.addEventListener("change", () => {
    chrome.storage.sync.set({ enabled: toggle.checked });
  });

  sensitivitySelect.addEventListener("change", () => {
    chrome.storage.sync.set({ sensitivity: sensitivitySelect.value });
  });

  function pollStats() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0] || !tabs[0].id) return;

      chrome.tabs.sendMessage(tabs[0].id, { type: "GET_STATS" }, (response) => {
        if (chrome.runtime.lastError || !response) {
          flashCountEl.textContent = "--";
          statusBadge.textContent = "INACTIVE";
          statusBadge.className = "status-badge";
          return;
        }

        flashCountEl.textContent = response.flashesPerSecond;

        if (response.isDangerous) {
          statusBadge.textContent = "FLASH DETECTED";
          statusBadge.className = "status-badge danger";
        } else {
          statusBadge.textContent = "SAFE";
          statusBadge.className = "status-badge safe";
        }
      });
    });
  }

  setInterval(pollStats, 300);
  pollStats();
});
