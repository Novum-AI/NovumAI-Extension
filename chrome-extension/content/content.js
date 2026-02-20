// NovumAI Content Script - Injected on Google Meet pages
// Creates and manages the floating overlay panel with FA icons

(() => {
  if (document.getElementById('novumai-overlay')) return;

  // Font Awesome is loaded via manifest.json content_scripts CSS injection

  // ─── State ──────────────────────────────────────────────────────────────

  const state = {
    isCollapsed: false,
    isHidden: true,
    isDragging: false,
    dragOffset: { x: 0, y: 0 },
    currentStreamingSuggestion: null,
    currentStage: 'CALL_OPENING',
    sentiment: { label: 'neutral', intensity: 0 },
    elapsedSeconds: 0,
    _wasAutoHidden: false,
  };

  const STAGE_LABELS = {
    CALL_OPENING: 'Call Opening',
    BUILD_RAPPORT: 'Build Rapport',
    PERMISSION_TO_QUESTION: 'Permission to Question',
    PROBLEM_AWARENESS: 'Problem Awareness',
    SOLUTION_AWARENESS: 'Solution Awareness',
    CONSEQUENCE: 'Consequence',
    PRESENTATION: 'Presentation',
    OBJECTION_HANDLING: 'Objection Handling',
    COMMITMENT: 'Commitment',
    CALL_TERMINATION: 'Call Termination',
    CONFIRM_UNDERSTANDING: 'Confirm Understanding',
    CLOSE_DEAL: 'Close Deal',
  };

  // ─── Create Overlay ─────────────────────────────────────────────────────

  function createOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'novumai-overlay';
    overlay.className = 'novumai-hidden';

    overlay.innerHTML = `
      <div class="novumai-panel">
        <div class="novumai-header" id="novumai-drag-handle">
          <div class="novumai-header-left">
            <div class="novumai-logo">N</div>
            <span class="novumai-title">NovumAI Coach</span>
          </div>
          <div class="novumai-header-right">
            <span class="novumai-elapsed" id="novumai-elapsed">00:00</span>
            <button class="novumai-btn-icon" id="novumai-collapse-btn" title="Minimize">
              <i class="fa-solid fa-minus"></i>
            </button>
            <button class="novumai-btn-icon" id="novumai-close-btn" title="Hide overlay">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
        </div>

        <div class="novumai-stage" id="novumai-stage-bar">
          <div class="novumai-stage-dot"></div>
          <span class="novumai-stage-label">Stage:</span>
          <span class="novumai-stage-name" id="novumai-stage-name">Call Opening</span>
        </div>

        <div class="novumai-sentiment" id="novumai-sentiment-bar">
          <div class="novumai-sentiment-dot neutral" id="novumai-sentiment-dot"></div>
          <span id="novumai-sentiment-text">Waiting for conversation...</span>
        </div>

        <div class="novumai-suggestions" id="novumai-suggestions">
          <div class="novumai-empty">
            <i class="fa-solid fa-microphone-lines"></i>
            <div>Listening for conversation...</div>
            <div style="margin-top:4px;font-size:11px;">AI coaching suggestions will appear here</div>
          </div>
        </div>

        <div class="novumai-transcript-line" id="novumai-transcript" style="display:none;">
          <span class="speaker"></span> <span class="text"></span>
        </div>
      </div>

      <div class="novumai-pill" id="novumai-pill">
        <div class="novumai-pill-dot"></div>
        <span class="novumai-pill-text"><i class="fa-solid fa-bolt" style="margin-right:4px;"></i>NovumAI Active</span>
      </div>
    `;

    document.body.appendChild(overlay);
    setupEventListeners(overlay);
    return overlay;
  }

  // ─── Events ─────────────────────────────────────────────────────────────

  function setupEventListeners(overlay) {
    overlay.querySelector('#novumai-collapse-btn').addEventListener('click', toggleCollapse);
    overlay.querySelector('#novumai-close-btn').addEventListener('click', hideOverlay);
    overlay.querySelector('#novumai-pill').addEventListener('click', toggleCollapse);

    const header = overlay.querySelector('#novumai-drag-handle');
    header.addEventListener('mousedown', startDrag);
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', endDrag);

    observeScreenShare();
  }

  // ─── Drag ───────────────────────────────────────────────────────────────

  function startDrag(e) {
    if (e.target.closest('.novumai-btn-icon')) return;
    const overlay = document.getElementById('novumai-overlay');
    const rect = overlay.getBoundingClientRect();
    state.isDragging = true;
    state.dragOffset.x = e.clientX - rect.left;
    state.dragOffset.y = e.clientY - rect.top;
    overlay.classList.add('novumai-dragging');
    e.preventDefault();
  }

  function onDrag(e) {
    if (!state.isDragging) return;
    const overlay = document.getElementById('novumai-overlay');
    const x = Math.max(0, Math.min(window.innerWidth - 100, e.clientX - state.dragOffset.x));
    const y = Math.max(0, Math.min(window.innerHeight - 50, e.clientY - state.dragOffset.y));
    overlay.style.left = x + 'px';
    overlay.style.top = y + 'px';
    overlay.style.right = 'auto';
    overlay.style.bottom = 'auto';
  }

  function endDrag() {
    if (!state.isDragging) return;
    state.isDragging = false;
    document.getElementById('novumai-overlay')?.classList.remove('novumai-dragging');
  }

  // ─── Visibility ─────────────────────────────────────────────────────────

  function showOverlay() {
    const o = document.getElementById('novumai-overlay');
    if (o) { o.classList.remove('novumai-hidden'); state.isHidden = false; }
  }

  function hideOverlay() {
    const o = document.getElementById('novumai-overlay');
    if (o) { o.classList.add('novumai-hidden'); state.isHidden = true; }
  }

  function toggleCollapse() {
    const o = document.getElementById('novumai-overlay');
    if (!o) return;
    state.isCollapsed = !state.isCollapsed;
    o.classList.toggle('novumai-collapsed', state.isCollapsed);
  }

  // ─── Screen Share Detection ─────────────────────────────────────────────

  function observeScreenShare() {
    const observer = new MutationObserver(() => {
      const presenting = document.querySelector(
        '[data-is-presenting="true"], [aria-label="Stop presenting"], [data-tooltip="Stop presenting"]'
      );
      if (presenting && !state.isHidden) {
        hideOverlay();
        state._wasAutoHidden = true;
      } else if (!presenting && state._wasAutoHidden) {
        showOverlay();
        state._wasAutoHidden = false;
      }
    });
    observer.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-is-presenting', 'aria-label'],
    });
  }

  // ─── Update Helpers ─────────────────────────────────────────────────────

  function updateStage(stage) {
    state.currentStage = stage;
    const el = document.getElementById('novumai-stage-name');
    if (el) el.textContent = STAGE_LABELS[stage] || stage.replace(/_/g, ' ');
  }

  function updateSentiment(data) {
    state.sentiment = data;
    const dot = document.getElementById('novumai-sentiment-dot');
    const text = document.getElementById('novumai-sentiment-text');
    if (dot) dot.className = `novumai-sentiment-dot ${data.label}`;
    if (text) {
      const label = data.label.charAt(0).toUpperCase() + data.label.slice(1);
      text.textContent = data.speaker ? `${data.speaker}: ${label}` : label;
    }
  }

  function updateTranscript(data) {
    const el = document.getElementById('novumai-transcript');
    if (!el) return;
    el.style.display = 'block';
    el.querySelector('.speaker').textContent = data.speaker + ':';
    el.querySelector('.text').textContent = data.text.slice(0, 80) + (data.text.length > 80 ? '...' : '');
  }

  function updateElapsed(seconds) {
    state.elapsedSeconds = seconds;
    const el = document.getElementById('novumai-elapsed');
    if (el) {
      const m = Math.floor(seconds / 60).toString().padStart(2, '0');
      const s = (seconds % 60).toString().padStart(2, '0');
      el.textContent = `${m}:${s}`;
    }
  }

  // ─── Suggestions ────────────────────────────────────────────────────────

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function renderSuggestionContent(text, contentMode) {
    if (!text) return '';
    if (contentMode === 'bullets') {
      return text.split('@@').filter(Boolean)
        .map(b => `<div class="novumai-suggestion-bullet"><span>${escapeHtml(b.trim())}</span></div>`)
        .join('');
    }
    return `<div>${escapeHtml(text)}</div>`;
  }

  function handleSuggestionStreaming(data) {
    const container = document.getElementById('novumai-suggestions');
    if (!container) return;

    if (data.status === 'started') {
      state.currentStreamingSuggestion = { id: data.suggestionId, text: '', contentMode: data.contentMode };
      const empty = container.querySelector('.novumai-empty');
      if (empty) empty.remove();
      const prev = container.querySelector('.novumai-suggestion-item.latest');
      if (prev) { prev.classList.remove('latest'); prev.classList.add('previous'); }
      const el = document.createElement('div');
      el.className = 'novumai-suggestion-item latest';
      el.id = `novumai-sug-${data.suggestionId}`;
      el.innerHTML = '<span class="novumai-cursor"></span>';
      container.prepend(el);
    } else if (data.status === 'chunk' && state.currentStreamingSuggestion) {
      state.currentStreamingSuggestion.text += data.text;
      const el = document.getElementById(`novumai-sug-${state.currentStreamingSuggestion.id}`);
      if (el) {
        el.innerHTML = renderSuggestionContent(state.currentStreamingSuggestion.text, state.currentStreamingSuggestion.contentMode || 'bullets')
          + '<span class="novumai-cursor"></span>';
      }
    } else if (data.status === 'completed') {
      const cursor = container.querySelector('.novumai-cursor');
      if (cursor) cursor.remove();
      state.currentStreamingSuggestion = null;
    }
    container.scrollTop = 0;
  }

  function handleSuggestionComplete(data) {
    const container = document.getElementById('novumai-suggestions');
    if (!container) return;
    const empty = container.querySelector('.novumai-empty');
    if (empty) empty.remove();

    let el = document.getElementById(`novumai-sug-${data.suggestionId}`);
    if (!el) {
      const prev = container.querySelector('.novumai-suggestion-item.latest');
      if (prev) { prev.classList.remove('latest'); prev.classList.add('previous'); }
      el = document.createElement('div');
      el.className = 'novumai-suggestion-item latest';
      el.id = `novumai-sug-${data.suggestionId}`;
      container.prepend(el);
    }
    el.innerHTML = renderSuggestionContent(data.suggestion, data.contentMode || 'bullets');
    const cursor = el.querySelector('.novumai-cursor');
    if (cursor) cursor.remove();

    // Keep max 5
    const items = container.querySelectorAll('.novumai-suggestion-item');
    for (let i = 5; i < items.length; i++) items[i].remove();
    container.scrollTop = 0;
  }

  function showQuotaWarning(data) {
    const panel = document.querySelector('.novumai-panel');
    if (!panel) return;
    const existing = panel.querySelector('.novumai-quota-warning');
    if (existing) existing.remove();
    const w = document.createElement('div');
    w.className = 'novumai-quota-warning';
    w.innerHTML = `<i class="fa-solid fa-triangle-exclamation" style="margin-right:4px;"></i>${escapeHtml(data.message || 'Smart Suggestions limit reached')}`;
    panel.insertBefore(w, panel.querySelector('.novumai-suggestions'));
  }

  // ─── Message Listener ──────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'SESSION_STARTED': showOverlay(); break;
      case 'SESSION_ENDED': hideOverlay(); break;
      case 'SESSION_STATE':
        if (message.data?.elapsedSeconds !== undefined) updateElapsed(message.data.elapsedSeconds);
        break;
      case 'TRANSCRIPT_PARTIAL':
      case 'TRANSCRIPT_FINAL':
        updateTranscript(message.data); break;
      case 'SUGGESTION_STREAMING': handleSuggestionStreaming(message.data); break;
      case 'SUGGESTION_COMPLETE': handleSuggestionComplete(message.data); break;
      case 'STAGE_UPDATE': updateStage(message.data.stage); break;
      case 'SENTIMENT_UPDATE': updateSentiment(message.data); break;
      case 'QUOTA_EXCEEDED': showQuotaWarning(message.data); break;
      case 'PROFILE_INCOMPLETE':
        const c = document.getElementById('novumai-suggestions');
        if (c) c.innerHTML = `<div class="novumai-empty"><i class="fa-solid fa-circle-exclamation"></i><div>${escapeHtml(message.data.message)}</div></div>`;
        break;
    }
    sendResponse({ received: true });
    return true;
  });

  // ─── Init ───────────────────────────────────────────────────────────────

  createOverlay();
  console.log('[NovumAI] Content script loaded on Google Meet');
})();
