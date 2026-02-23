// NovumAI Debug Logger
// Centralized logging with component tags, levels, and chrome.storage toggle
//
// Usage:
//   import { debug } from '../lib/debug.js';
//   const log = debug('ServiceWorker');
//   log.info('Session started', { tabId: 123 });
//   log.warn('Retry queued');
//   log.error('WS failed', error);
//
// Enable/disable in devtools console:
//   chrome.storage.local.set({ novumai_debug: true });   // enable
//   chrome.storage.local.set({ novumai_debug: false });  // disable (default)
//
// View all logs in:
//   Service Worker:  chrome://extensions → NovumAI → "service worker" link
//   Popup:           Right-click popup → Inspect
//   Content Script:  Google Meet tab → DevTools → Console (filter: [NovumAI])
//   Offscreen:       chrome://extensions → NovumAI → "offscreen.html" link

let _debugEnabled = false;

// Load debug setting (non-blocking)
try {
  chrome.storage.local.get('novumai_debug', (result) => {
    _debugEnabled = result?.novumai_debug === true;
  });
  // Listen for changes in real-time
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.novumai_debug) {
      _debugEnabled = changes.novumai_debug.newValue === true;
    }
  });
} catch {
  // Content scripts may not have storage access in all contexts
}

const STYLES = {
  info: 'color: #818cf8; font-weight: 600;',
  warn: 'color: #fbbf24; font-weight: 600;',
  error: 'color: #f87171; font-weight: 600;',
  event: 'color: #34d399; font-weight: 600;',
};

export function debug(component) {
  const prefix = `[NovumAI:${component}]`;

  return {
    /** General info (only when debug enabled) */
    info(msg, ...args) {
      if (!_debugEnabled) return;
      console.log(`%c${prefix} ${msg}`, STYLES.info, ...args);
    },

    /** Warnings (always shown) */
    warn(msg, ...args) {
      console.warn(`${prefix} ${msg}`, ...args);
    },

    /** Errors (always shown) */
    error(msg, ...args) {
      console.error(`${prefix} ${msg}`, ...args);
    },

    /** Events / lifecycle (only when debug enabled) */
    event(msg, ...args) {
      if (!_debugEnabled) return;
      console.log(`%c${prefix} ⚡ ${msg}`, STYLES.event, ...args);
    },

    /** Force log regardless of debug setting (for critical startup info) */
    always(msg, ...args) {
      console.log(`${prefix} ${msg}`, ...args);
    },
  };
}
