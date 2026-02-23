// NovumAI Extension Popup
import { MSG } from '../lib/messages.js';
import { CONFIG } from '../lib/config.js';
import { debug } from '../lib/debug.js';

const log = debug('Popup');

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
  businessMode: document.getElementById('business-mode'),
  leadPhone: document.getElementById('lead-phone'),
  btnSearchLead: document.getElementById('btn-search-lead'),
  leadResult: document.getElementById('lead-result'),
  leadCreateForm: document.getElementById('lead-create-form'),
  errorBar: document.getElementById('error-bar'),
  errorText: document.getElementById('error-text'),
  errorDismiss: document.getElementById('error-dismiss'),
};

// ─── State ───────────────────────────────────────────────────────────────────

let currentTab = null;
let durationInterval = null;
let selectedLead = null;

// ─── Utilities ───────────────────────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Format phone to E.164 before sending to backend (expects +15551234567)
function formatPhoneNumber(phone) {
  const clean = phone.replace(/[\s\-\(\)\.]/g, '');
  if (clean.startsWith('+')) return clean;
  if (/^\d{10}$/.test(clean)) return `+1${clean}`;          // US 10-digit
  if (/^1\d{10}$/.test(clean)) return `+${clean}`;          // US 11-digit with country code
  if (/^\d{7,15}$/.test(clean)) return `+${clean}`;         // Other international
  return clean;
}

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
  log.info('Popup init...');

  // Load saved environment
  const stored = await chrome.storage.local.get(['environment']);
  if (stored.environment) {
    els.envSelect.value = stored.environment;
  }
  log.info('Environment:', stored.environment || 'development (default)');

  // Check current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  log.info('Current tab:', { id: tab?.id, url: tab?.url?.substring(0, 60) });

  // Check auth
  const authResult = await sendMessage({ type: MSG.CHECK_AUTH });
  log.info('Auth result:', { authenticated: authResult?.authenticated, email: authResult?.user?.email });

  if (!authResult?.authenticated) {
    showView('loggedOut');
    return;
  }

  // Check if there's an active session
  const state = await sendMessage({ type: MSG.GET_SESSION_STATE });
  log.info('Session state:', { hasActive: state?.hasActiveSession, stage: state?.currentStage, lead: state?.lead?.customer_number });

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

  // Business mode
  if (state?.businessMode) {
    els.businessMode.value = state.businessMode;
  }

  // Restore lead if one was previously selected
  if (state?.lead) {
    selectedLead = state.lead;
    showLeadCard(state.lead);
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

// ─── Lead Search & Create ───────────────────────────────────────────────────

async function searchLead() {
  const query = els.leadPhone.value.trim();
  if (!query || query.length < 2) {
    showError('Enter at least 2 characters to search');
    return;
  }
  log.info('Searching leads:', query);

  els.btnSearchLead.disabled = true;
  els.btnSearchLead.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';

  const result = await sendMessage({
    type: MSG.SEARCH_LEADS,
    data: { query },
  });
  log.info('Lead search result:', result);

  els.btnSearchLead.disabled = false;
  els.btnSearchLead.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i>';

  if (result?.success && result.leads?.length === 1) {
    // Single match — auto-select
    selectedLead = result.leads[0];
    showLeadCard(result.leads[0]);
    sendMessage({ type: MSG.SET_LEAD, data: { lead: result.leads[0] } });
  } else if (result?.success && result.leads?.length > 1) {
    // Multiple matches — show list for user to pick
    selectedLead = null;
    showLeadList(result.leads);
  } else if (result?.success) {
    // No matches
    selectedLead = null;
    showLeadNotFound(query);
  } else {
    showError(result?.error || 'Lead search failed');
  }
}

function showLeadCard(lead) {
  els.leadResult.classList.remove('hidden');
  els.leadCreateForm.classList.add('hidden');
  const name = `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || 'Unknown';
  els.leadResult.innerHTML = `
    <div class="p-3 bg-slate-800 border border-green-800 rounded-xl">
      <div class="flex items-center justify-between mb-1">
        <span class="text-sm font-semibold text-slate-200"><i class="fa-solid fa-user-check text-green-500 mr-1.5 text-xs"></i>${escapeHtml(name)}</span>
        <button id="btn-clear-lead" class="text-xs text-slate-500 hover:text-slate-300 px-1" title="Remove lead">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
      ${lead.company_name ? `<div class="text-xs text-slate-400 ml-5">${escapeHtml(lead.company_name)}${lead.job_title ? ' &middot; ' + escapeHtml(lead.job_title) : ''}</div>` : ''}
      ${lead.customer_number ? `<div class="text-xs text-slate-500 mt-1 ml-5"><i class="fa-solid fa-phone text-slate-600 mr-1" style="font-size:9px;"></i>${escapeHtml(lead.customer_number)}</div>` : ''}
    </div>
  `;
  document.getElementById('btn-clear-lead')?.addEventListener('click', clearLead);
}

function showLeadList(leads) {
  els.leadResult.classList.remove('hidden');
  els.leadCreateForm.classList.add('hidden');
  const items = leads.map((lead, i) => {
    const name = `${lead.first_name || ''} ${lead.last_name || ''}`.trim() || 'Unknown';
    const detail = [lead.company_name, lead.customer_number].filter(Boolean).join(' · ');
    return `
      <button class="lead-pick-btn w-full text-left p-2 rounded-lg bg-slate-700 hover:bg-slate-600 transition-colors mb-1.5" data-lead-idx="${i}">
        <div class="text-sm font-medium text-slate-200">${escapeHtml(name)}</div>
        ${detail ? `<div class="text-xs text-slate-400 mt-0.5">${escapeHtml(detail)}</div>` : ''}
      </button>`;
  }).join('');
  els.leadResult.innerHTML = `
    <div class="p-2 bg-slate-800 border border-slate-700 rounded-xl">
      <p class="text-xs text-slate-400 mb-2">${leads.length} results found — pick one:</p>
      ${items}
    </div>
  `;
  // Attach click handlers
  els.leadResult.querySelectorAll('.lead-pick-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.leadIdx, 10);
      selectedLead = leads[idx];
      showLeadCard(leads[idx]);
      sendMessage({ type: MSG.SET_LEAD, data: { lead: leads[idx] } });
    });
  });
}

function showLeadNotFound(query) {
  els.leadResult.classList.remove('hidden');
  els.leadCreateForm.classList.add('hidden');
  els.leadResult.innerHTML = `
    <div class="p-3 bg-slate-800 border border-slate-700 rounded-xl text-center">
      <p class="text-xs text-slate-400 mb-2">No lead found for <span class="text-slate-300">${escapeHtml(query)}</span></p>
      <button id="btn-show-create" class="text-xs text-novum-400 hover:text-novum-300 font-semibold">
        <i class="fa-solid fa-plus mr-1"></i>Create Lead
      </button>
    </div>
  `;
  document.getElementById('btn-show-create')?.addEventListener('click', showCreateLeadForm);
}

function clearLead() {
  selectedLead = null;
  els.leadResult.classList.add('hidden');
  els.leadResult.innerHTML = '';
  els.leadPhone.value = '';
  els.leadCreateForm.classList.add('hidden');
  sendMessage({ type: MSG.SET_LEAD, data: { lead: null } });
}

function showCreateLeadForm() {
  els.leadCreateForm.classList.remove('hidden');
  els.leadCreateForm.innerHTML = `
    <div class="p-3 bg-slate-800 border border-slate-700 rounded-xl space-y-2 mt-2">
      <input id="create-first-name" type="text" placeholder="First name"
        class="w-full px-2 py-1.5 border border-slate-700 rounded-md bg-slate-900 text-slate-200 text-xs outline-none focus:border-novum-500">
      <input id="create-last-name" type="text" placeholder="Last name"
        class="w-full px-2 py-1.5 border border-slate-700 rounded-md bg-slate-900 text-slate-200 text-xs outline-none focus:border-novum-500">
      <input id="create-email" type="email" placeholder="Email (optional)"
        class="w-full px-2 py-1.5 border border-slate-700 rounded-md bg-slate-900 text-slate-200 text-xs outline-none focus:border-novum-500">
      <input id="create-company" type="text" placeholder="Company (optional)"
        class="w-full px-2 py-1.5 border border-slate-700 rounded-md bg-slate-900 text-slate-200 text-xs outline-none focus:border-novum-500">
      <div class="flex gap-2 pt-1">
        <button id="btn-create-lead" class="flex-1 py-1.5 rounded-md bg-novum-600 text-white text-xs font-semibold hover:bg-novum-500 transition-colors">Create</button>
        <button id="btn-cancel-create" class="flex-1 py-1.5 rounded-md bg-slate-700 text-slate-300 text-xs hover:bg-slate-600 transition-colors">Cancel</button>
      </div>
    </div>
  `;
  document.getElementById('btn-create-lead')?.addEventListener('click', createLead);
  document.getElementById('btn-cancel-create')?.addEventListener('click', () => {
    els.leadCreateForm.classList.add('hidden');
  });
}

async function createLead() {
  const btn = document.getElementById('btn-create-lead');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Creating...';

  const data = {
    first_name: document.getElementById('create-first-name')?.value.trim() || '',
    last_name: document.getElementById('create-last-name')?.value.trim() || '',
    email: document.getElementById('create-email')?.value.trim() || '',
    company_name: document.getElementById('create-company')?.value.trim() || '',
    customer_number: formatPhoneNumber(els.leadPhone.value.trim()),
    source: 'extension',
  };

  const result = await sendMessage({ type: MSG.CREATE_LEAD, data });

  if (result?.success && result.lead) {
    selectedLead = result.lead;
    showLeadCard(result.lead);
    els.leadCreateForm.classList.add('hidden');
    sendMessage({ type: MSG.SET_LEAD, data: { lead: result.lead } });
  } else {
    showError(result?.error || 'Failed to create lead');
    btn.disabled = false;
    btn.textContent = 'Create';
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
  const url = env === 'production'
    ? 'https://www.novumai.co'
    : 'https://dev.novumai.co';
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
    data: {
      tabId: currentTab.id,
      lead: selectedLead,
    },
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

// Business mode
els.businessMode.addEventListener('change', () => {
  sendMessage({ type: MSG.SET_BUSINESS_MODE, data: { businessMode: els.businessMode.value } });
});

// Lead search
els.btnSearchLead.addEventListener('click', searchLead);
els.leadPhone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') searchLead();
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
