'use strict';

const badge    = document.getElementById('bridge-badge');
const dot      = document.getElementById('bridge-dot');
const lastEl   = document.getElementById('last-capture');

fetch('http://127.0.0.1:9224/status')
  .then(r => r.json())
  .then(({ lastCapture }) => {
    badge.className = 'badge ok';
    badge.innerHTML = '<span class="dot ok"></span>&nbsp;Connected';

    if (lastCapture) {
      const d = new Date(lastCapture);
      lastEl.innerHTML =
        `Last capture at <strong>${d.toLocaleTimeString()}</strong>`;
    }
  })
  .catch(() => {
    badge.className = 'badge error';
    badge.innerHTML = '<span class="dot error"></span>&nbsp;Offline';
    lastEl.textContent = 'Start the MCP server, then reload.';
  });
