// NovumAI Extension Popup
import { MSG } from '../lib/messages.js';
import { CONFIG } from '../lib/config.js';

// ─── DOM Elements ────────────────────────────────────────────────────────────

const views = {
  loading: document.getElementById('view-loading'),
  loggedOut: document.getElementById('view-logged-out'),
  idle: document.getElementById('view-idle'),
  active: document.getElementById('view-active'),
};

const els = {
  btnLogin: document.getElementById('btn-login'),
  btnStart: document.getElementById('btn-start'),
  btnEnd: document.getElementById('btn-end'),
  envSelect: document.getElementById('env-select'),
  userBadge: document.getElementById('user-badge'),
  userEmail: document.getElementById('user-email'),
  pageStatus: document.getElementById('page-status'),
  statusIcon: document.getElementById('status-icon'),
  statusLabel: document.getElementById('status-label'),
  statusDetail: document.getElementById('status-detail'),
  startHelp: document.getElementById('start-help'),
  sessionDuration: document.getElementById('session-duration'),
  sessionStage: document.getElementById('session-stage'),
  contentMode: document.getElementById('content-mode'),
  errorBar: document.getElementById('error-bar'),
  errorText: document.getElementById('error-text'),
  errorDismiss: document.getElementById('error-dismiss'),
};

// ─── State ───────────────────────────────────────────────────────────────────

let currentTab = null;
let durationInterval = null;

// ─── View Management ─────────────────────────────────────────────────────────

function showView(viewName) {
  Object.values(views).forEach((v) => v.classList.add('hidden'));
  views[viewName]?.classList.remove('hidden');
}

function showError(message) {
  els.errorText.textContent = message;
  els.errorBar.classList.remove('hidden');
  setTimeout(() => els.errorBar.classList.add('hidden'), 5000);
}

// ─── Initialize ──────────────────────────────────────────────────────────────

async function init() {
  showView('loading');

  // Load saved environment
  const stored = await chrome.storage.local.get(['environment']);
  if (stored.environment) {
    els.envSelect.value = stored.environment;
  }

  // Check current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;

  // Check auth
  const authResult = await sendMessage({ type: MSG.CHECK_AUTH });

  if (!authResult?.authenticated) {
    showView('loggedOut');
    return;
  }

  // Check if there's an active session
  const state = await sendMessage({ type: MSG.GET_SESSION_STATE });

  if (state?.hasActiveSession) {
    showActiveView(state);
    return;
  }

  showIdleView(authResult, state);
}

// ─── Idle View ───────────────────────────────────────────────────────────────

function showIdleView(authResult, state) {
  showView('idle');

  // User info
  const user = authResult.user || state?.user;
  if (user) {
    els.userEmail.textContent = user.email || '';
    els.userBadge.textContent = (user.role || 'Agent').replace(/-/g, ' ');
  }

  // Content mode
  if (state?.contentMode) {
    els.contentMode.value = state.contentMode;
  }

  // Page status
  updatePageStatus();
}

function updatePageStatus() {
  const isSupported = currentTab?.url && CONFIG.SUPPORTED_URLS.some((u) => currentTab.url.startsWith(u));
  const isMeetCall = isSupported && currentTab.url.includes('/meet.google.com/') && !currentTab.url.endsWith('meet.google.com/');

  if (isMeetCall) {
    els.statusIcon.innerHTML = '<i class="fa-solid fa-circle text-green-500 text-xs"></i>';
    els.statusLabel.textContent = 'Ready to coach';
    els.statusDetail.textContent = 'Google Meet call detected';
    els.pageStatus.classList.add('ready');
    els.btnStart.disabled = false;
    els.startHelp.textContent = 'Click to start real-time coaching';
  } else if (isSupported) {
    els.statusIcon.innerHTML = '<i class="fa-solid fa-circle text-yellow-500 text-xs"></i>';
    els.statusLabel.textContent = 'On Google Meet';
    els.statusDetail.textContent = 'Join a call to enable coaching';
    els.pageStatus.classList.remove('ready');
    els.btnStart.disabled = true;
    els.startHelp.textContent = 'Join a call first';
  } else {
    els.statusIcon.innerHTML = '<i class="fa-solid fa-circle text-red-500 text-xs"></i>';
    els.statusLabel.textContent = 'Not on a supported page';
    els.statusDetail.textContent = 'Navigate to Google Meet to start coaching';
    els.pageStatus.classList.remove('ready');
    els.btnStart.disabled = true;
    els.startHelp.textContent = 'Open Google Meet to get started';
  }
}

// ─── Active Session View ─────────────────────────────────────────────────────

function showActiveView(state) {
  showView('active');

  // Start duration counter
  let elapsed = state.elapsedSeconds || 0;
  updateDurationDisplay(elapsed);

  if (durationInterval) clearInterval(durationInterval);
  durationInterval = setInterval(() => {
    elapsed++;
    updateDurationDisplay(elapsed);
  }, 1000);

  // Stage
  if (state.currentStage) {
    const label = state.currentStage.replace(/_/g, ' ');
    els.sessionStage.textContent = label.charAt(0) + label.slice(1).toLowerCase();
  }
}

function updateDurationDisplay(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  els.sessionDuration.textContent = `${m}:${s}`;
}

// ─── Event Listeners ─────────────────────────────────────────────────────────

// Login button
els.btnLogin.addEventListener('click', async () => {
  const env = els.envSelect.value;
  const url = env === 'production' ? 'https://www.novumai.co' : 'https://dev.novumai.co';
  chrome.tabs.create({ url });
});

// Environment selector
els.envSelect.addEventListener('change', async () => {
  await chrome.storage.local.set({ environment: els.envSelect.value });
  // Re-check auth with new environment
  init();
});

// Start session
els.btnStart.addEventListener('click', async () => {
  if (!currentTab?.id) {
    showError('No active tab found');
    return;
  }

  els.btnStart.disabled = true;
  els.btnStart.textContent = 'Starting...';

  const result = await sendMessage({
    type: MSG.START_SESSION,
    data: { tabId: currentTab.id },
  });

  if (result?.success) {
    const state = await sendMessage({ type: MSG.GET_SESSION_STATE });
    showActiveView(state || { elapsedSeconds: 0 });
  } else {
    showError(result?.error || 'Failed to start session');
    els.btnStart.disabled = false;
    els.btnStart.textContent = 'Start Coaching';
  }
});

// End session
els.btnEnd.addEventListener('click', async () => {
  els.btnEnd.disabled = true;
  els.btnEnd.textContent = 'Ending...';

  const result = await sendMessage({ type: MSG.END_SESSION });

  if (durationInterval) {
    clearInterval(durationInterval);
    durationInterval = null;
  }

  if (result?.success && result.summary) {
    await chrome.storage.local.set({ lastSession: result.summary });
    // Post-call analytics page is now opened by the service worker
    // redirecting to the webapp: https://(dev.)novumai.co/call-analytics/{callConnectionId}
  }

  // Back to idle
  const authResult = await sendMessage({ type: MSG.CHECK_AUTH });
  const state = await sendMessage({ type: MSG.GET_SESSION_STATE });
  showIdleView(authResult || {}, state || {});

  els.btnEnd.disabled = false;
  els.btnEnd.textContent = 'End Session';
});

// Content mode
els.contentMode.addEventListener('change', () => {
  sendMessage({ type: MSG.SET_CONTENT_MODE, data: { contentMode: els.contentMode.value } });
});

// Error dismiss
els.errorDismiss.addEventListener('click', () => {
  els.errorBar.classList.add('hidden');
});

// ─── Messaging ───────────────────────────────────────────────────────────────

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[NovumAI Popup]', chrome.runtime.lastError.message);
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}

// ─── Init ────────────────────────────────────────────────────────────────────

init();
