// NovumAI Content Script - Injected on Google Meet pages
// Creates and manages the floating overlay panel with inline SVG icons

(() => {
  // A stale overlay div can survive an extension remove/reinstall because the
  // content script's isolated world is torn down but the DOM it appended to the
  // main world persists. If we early-return here the message listener below
  // never registers, and every chrome.tabs.sendMessage from the SW fails with
  // "Receiving end does not exist." Instead, tear down any stale overlay and
  // re-initialise cleanly.
  const staleOverlay = document.getElementById('novumai-overlay');
  if (staleOverlay) staleOverlay.remove();

  // ─── Inline SVG Icons ────────────────────────────────────────────────────
  // We use inline SVGs instead of Font Awesome webfonts in the content script.
  // FA webfonts don't work in content scripts because @font-face url() paths
  // resolve relative to the page origin (meet.google.com), not the extension.
  // Inline SVGs have zero dependencies — they render instantly as part of the DOM.
  const ICONS = {
    minus: '<svg class="novumai-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><path fill="currentColor" d="M0 256c0-17.7 14.3-32 32-32l384 0c17.7 0 32 14.3 32 32s-14.3 32-32 32L32 288c-17.7 0-32-14.3-32-32z"/></svg>',
    xmark: '<svg class="novumai-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512"><path fill="currentColor" d="M342.6 150.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L192 210.7 86.6 105.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L146.7 256 41.4 361.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L192 301.3l105.4 105.3c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L237.3 256l105.3-105.4z"/></svg>',
    plugCircleExclamation: '<svg class="novumai-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 512"><path fill="currentColor" d="M192 0c17.7 0 32 14.3 32 32l0 96 128 0 0-96c0-17.7 14.3-32 32-32s32 14.3 32 32l0 96 64 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l0 48.7c-98.6 8.1-176 90.7-176 191.3c0 27.3 5.7 53.3 16 76.9l0 3.1c0 17.7-14.3 32-32 32s-32-14.3-32-32l0-66.7C165.2 398.1 96 319.1 96 224l0-64c-17.7 0-32-14.3-32-32s14.3-32 32-32l64 0 0-96c0-17.7 14.3-32 32-32zM496 256a144 144 0 1 1 0 288 144 144 0 1 1 0-288zm0 228a20 20 0 1 0 0-40 20 20 0 1 0 0 40zm0-180c-8.8 0-16 7.2-16 16l0 80c0 8.8 7.2 16 16 16s16-7.2 16-16l0-80c0-8.8-7.2-16-16-16z"/></svg>',
    message: '<svg class="novumai-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d="M0 352L0 128C0 75 43 32 96 32l320 0c53 0 96 43 96 96l0 224c0 53-43 96-96 96l-120 0c-5.2 0-10.2 1.7-14.4 4.8L166.4 539.2c-4.2 3.1-9.2 4.8-14.4 4.8c-13.3 0-24-10.7-24-24l0-72-32 0c-53 0-96-43-96-96z"/></svg>',
    bolt: '<svg class="novumai-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><path fill="currentColor" d="M349.4 44.6c5.9-13.7 1.5-29.7-10.6-38.5s-28.6-8-39.9 1.8l-256 224c-10 8.8-13.6 22.9-8.9 35.3S50.7 288 64 288l111.5 0L98.6 467.4c-5.9 13.7-1.5 29.7 10.6 38.5s28.6 8 39.9-1.8l256-224c10-8.8 13.6-22.9 8.9-35.3s-16.4-20.8-29.6-20.8l-111.5 0L349.4 44.6z"/></svg>',
    triangleExclamation: '<svg class="novumai-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d="M256 32c14.2 0 27.3 7.5 34.5 19.8l216 368c7.3 12.4 7.3 27.7 .2 40.1S486.3 480 472 480L40 480c-14.3 0-27.6-7.7-34.7-20.1s-7-27.8 .2-40.1l216-368C228.7 39.5 241.8 32 256 32zm0 128c-13.3 0-24 10.7-24 24l0 112c0 13.3 10.7 24 24 24s24-10.7 24-24l0-112c0-13.3-10.7-24-24-24zm32 224a32 32 0 1 0 -64 0 32 32 0 1 0 64 0z"/></svg>',
    circleExclamation: '<svg class="novumai-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d="M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zm0-384c13.3 0 24 10.7 24 24l0 112c0 13.3-10.7 24-24 24s-24-10.7-24-24l0-112c0-13.3 10.7-24 24-24zM224 352a32 32 0 1 1 64 0 32 32 0 1 1 -64 0z"/></svg>',
  };

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
            <div class="novumai-audio-health" id="novumai-audio-health">
              <span class="novumai-health-badge" id="novumai-mic-badge" title="My microphone"><span class="novumai-health-dot"></span>Me</span>
              <span class="novumai-health-badge" id="novumai-tab-badge" title="Remote audio"><span class="novumai-health-dot"></span>Remote</span>
            </div>
            <span class="novumai-elapsed" id="novumai-elapsed">00:00</span>
            <button class="novumai-btn-icon" id="novumai-collapse-btn" title="Minimize">
              ${ICONS.minus}
            </button>
            <button class="novumai-btn-icon" id="novumai-close-btn" title="Minimize to pill">
              ${ICONS.xmark}
            </button>
          </div>
        </div>

        <div class="novumai-connection-bar novumai-connection-hidden" id="novumai-connection-bar">
          <span style="margin-right:4px;display:inline-flex;">${ICONS.plugCircleExclamation}</span>
          <span id="novumai-connection-text">Reconnecting...</span>
        </div>

        <div class="novumai-stage" id="novumai-stage-bar">
          <div class="novumai-stage-dot"></div>
          <span class="novumai-stage-label">Stage:</span>
          <span class="novumai-stage-name" id="novumai-stage-name">Call Opening</span>
        </div>

        <div class="novumai-controls" id="novumai-controls">
          <div class="novumai-control-group">
            <label class="novumai-control-label">Content</label>
            <select class="novumai-select" id="novumai-content-mode">
              <option value="bullets">Bullets</option>
              <option value="notes">Full Notes</option>
            </select>
          </div>
          <div class="novumai-control-group">
            <label class="novumai-control-label">Mode</label>
            <select class="novumai-select" id="novumai-business-mode">
              <option value="sales">Sales</option>
              <option value="customer_support">Support</option>
              <option value="general">General</option>
            </select>
          </div>
        </div>

        <div class="novumai-sentiment" id="novumai-sentiment-bar">
          <div class="novumai-sentiment-dot neutral" id="novumai-sentiment-dot"></div>
          <span id="novumai-sentiment-text">Waiting for conversation...</span>
        </div>

        <div class="novumai-suggestions" id="novumai-suggestions">
          <div class="novumai-empty" id="novumai-empty-state">
            <div class="novumai-empty-pulse"></div>
            <div class="novumai-empty-title">Waiting for conversation...</div>
            <div class="novumai-empty-detail">Suggestions will appear once the conversation begins</div>
            <div class="novumai-empty-status" id="novumai-empty-status">
              <span class="novumai-empty-dot"></span> Audio connected
            </div>
          </div>
        </div>

        <div class="novumai-transcript" id="novumai-transcript">
          <div class="novumai-transcript-header">
            <span style="margin-right:4px;display:inline-flex;font-size:10px;">${ICONS.message}</span>Transcript
          </div>
          <div class="novumai-transcript-scroll" id="novumai-transcript-scroll"></div>
        </div>
      </div>

      <div class="novumai-pill" id="novumai-pill">
        <div class="novumai-pill-dot"></div>
        <span class="novumai-pill-text"><span style="margin-right:4px;display:inline-flex;">${ICONS.bolt}</span>NovumAI Active</span>
      </div>
    `;

    document.body.appendChild(overlay);
    setupEventListeners(overlay);
    return overlay;
  }

  // ─── Events ─────────────────────────────────────────────────────────────

  function setupEventListeners(overlay) {
    overlay.querySelector('#novumai-collapse-btn').addEventListener('click', toggleCollapse);

    // Close button now collapses to pill (recoverable) instead of fully hiding
    overlay.querySelector('#novumai-close-btn').addEventListener('click', () => {
      state.isCollapsed = true;
      const o = document.getElementById('novumai-overlay');
      if (o) o.classList.add('novumai-collapsed');
    });

    overlay.querySelector('#novumai-pill').addEventListener('click', toggleCollapse);

    // Controls: content mode and business mode
    overlay.querySelector('#novumai-content-mode').addEventListener('change', (e) => {
      chrome.runtime.sendMessage({
        type: 'SET_CONTENT_MODE',
        data: { contentMode: e.target.value },
      }).catch(() => {});
    });
    overlay.querySelector('#novumai-business-mode').addEventListener('change', (e) => {
      chrome.runtime.sendMessage({
        type: 'SET_BUSINESS_MODE',
        data: { businessMode: e.target.value },
      }).catch(() => {});
    });

    const header = overlay.querySelector('#novumai-drag-handle');
    header.addEventListener('mousedown', startDrag);
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', endDrag);

    observeScreenShare();
  }

  // ─── Drag ───────────────────────────────────────────────────────────────

  function startDrag(e) {
    if (e.target.closest('.novumai-btn-icon') || e.target.closest('.novumai-select')) return;
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
    if (o) {
      o.classList.remove('novumai-hidden');
      state.isHidden = false;
      state.isCollapsed = false;
      o.classList.remove('novumai-collapsed');
    }
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

  // Map internal speaker names to user-facing labels
  const SPEAKER_LABEL = { Agent: 'Me', Customer: 'Remote' };

  function updateSentiment(data) {
    state.sentiment = data;
    const dot = document.getElementById('novumai-sentiment-dot');
    const text = document.getElementById('novumai-sentiment-text');
    if (dot) dot.className = `novumai-sentiment-dot ${data.label}`;
    if (text) {
      const label = data.label.charAt(0).toUpperCase() + data.label.slice(1);
      const speakerName = SPEAKER_LABEL[data.speaker] || data.speaker;
      text.textContent = speakerName ? `${speakerName}: ${label}` : label;
    }
  }

  function updateTranscript(data) {
    const scroll = document.getElementById('novumai-transcript-scroll');
    if (!scroll) return;

    const speakerClass = data.speaker === 'Agent' ? 'agent' : 'customer';
    const displayName = SPEAKER_LABEL[data.speaker] || data.speaker;
    const isFinal = data.isFinal !== false;

    // Update empty state to show transcription is active
    const emptyStatus = document.getElementById('novumai-empty-status');
    if (emptyStatus) {
      emptyStatus.innerHTML = '<span class="novumai-empty-dot active"></span> Transcription active';
    }

    if (!isFinal) {
      // Update existing partial for this speaker, or create new
      const existing = scroll.querySelector(`.novumai-transcript-entry.partial.${speakerClass}`);
      if (existing) {
        existing.querySelector('.novumai-transcript-text').textContent = data.text;
        scroll.scrollTop = scroll.scrollHeight;
        return;
      }
      const entry = document.createElement('div');
      entry.className = `novumai-transcript-entry partial ${speakerClass}`;
      entry.innerHTML = `
        <span class="novumai-transcript-speaker ${speakerClass}">${escapeHtml(displayName)}</span>
        <span class="novumai-transcript-text">${escapeHtml(data.text)}</span>
      `;
      scroll.appendChild(entry);
    } else {
      // Remove any partial for this speaker
      const partial = scroll.querySelector(`.novumai-transcript-entry.partial.${speakerClass}`);
      if (partial) partial.remove();

      const entry = document.createElement('div');
      entry.className = `novumai-transcript-entry ${speakerClass}`;
      entry.innerHTML = `
        <span class="novumai-transcript-speaker ${speakerClass}">${escapeHtml(displayName)}</span>
        <span class="novumai-transcript-text">${escapeHtml(data.text)}</span>
      `;
      scroll.appendChild(entry);
    }

    // Keep max 50 entries
    const entries = scroll.querySelectorAll('.novumai-transcript-entry');
    if (entries.length > 50) entries[0].remove();

    scroll.scrollTop = scroll.scrollHeight;
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

  function updateAudioHealth(data) {
    const micBadge = document.getElementById('novumai-mic-badge');
    const tabBadge = document.getElementById('novumai-tab-badge');
    if (micBadge) {
      micBadge.className = `novumai-health-badge ${data.micAudio ? 'healthy' : 'unhealthy'}`;
      micBadge.title = data.micAudio ? 'My mic: active' : 'My mic: no signal';
    }
    if (tabBadge) {
      tabBadge.className = `novumai-health-badge ${data.tabAudio ? 'healthy' : 'unhealthy'}`;
      tabBadge.title = data.tabAudio ? 'Remote audio: active' : 'Remote audio: no signal';
    }
  }

  function updateConnectionStatus(data) {
    const bar = document.getElementById('novumai-connection-bar');
    if (!bar) return;
    if (data.connected) {
      bar.classList.add('novumai-connection-hidden');
    } else {
      bar.classList.remove('novumai-connection-hidden');
      const text = document.getElementById('novumai-connection-text');
      if (text) {
        text.textContent = data.reconnecting ? 'Connection lost. Reconnecting...' : 'Disconnected';
      }
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

    const pct = data.percentage || 100;
    let level = 'red';
    if (pct <= 75) level = 'yellow';
    else if (pct <= 90) level = 'orange';

    const w = document.createElement('div');
    w.className = `novumai-quota-warning novumai-quota-${level}`;
    w.innerHTML = `<span style="margin-right:4px;display:inline-flex;">${ICONS.triangleExclamation}</span>${escapeHtml(data.message || `${pct}% of suggestion quota used`)}`;
    panel.insertBefore(w, panel.querySelector('.novumai-suggestions'));
  }

  // ─── Microphone Capture ────────────────────────────────────────────────
  // Mic capture lives in the content script because:
  // 1. Google Meet already has mic permission (user granted it to join the call)
  // 2. Content scripts share the page's permissions for getUserMedia
  // 3. Offscreen documents can't trigger the mic permission prompt (they're invisible)

  const MIC_SAMPLE_RATE = 16000;

  let micAudioContext = null;
  let micMediaStream = null;
  let micProcessorNode = null;

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  async function startMicCapture() {
    try {
      console.log('[NovumAI:Content] Requesting microphone access...');
      micMediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: MIC_SAMPLE_RATE,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      console.log('[NovumAI:Content] Mic stream obtained, tracks:', micMediaStream.getAudioTracks().length);

      micAudioContext = new AudioContext({ sampleRate: MIC_SAMPLE_RATE });
      if (micAudioContext.state === 'suspended') {
        await micAudioContext.resume();
      }

      // AudioWorklet off the main thread. Module URL is web-accessible per manifest.
      const workletUrl = chrome.runtime.getURL('offscreen/pcm-processor-mic.js');
      await micAudioContext.audioWorklet.addModule(workletUrl);
      micProcessorNode = new AudioWorkletNode(micAudioContext, 'pcm-processor-mic');
      micProcessorNode.port.onmessage = (event) => {
        const buf = event.data?.audioData;
        if (!buf) return;
        const base64Audio = arrayBufferToBase64(buf);
        chrome.runtime.sendMessage({
          type: 'MIC_AUDIO_CHUNK',
          target: 'background',
          data: { audioData: base64Audio },
        }).catch(() => {});
      };

      const source = micAudioContext.createMediaStreamSource(micMediaStream);
      source.connect(micProcessorNode);
      // Deliberately NOT connected to destination — that used to route the mic back
      // to the user's speakers (echo). AudioWorkletNode runs purely by being in the
      // graph; no destination hookup required.

      console.log('[NovumAI:Content] ✓ Mic capture started (AudioWorklet)');
      return { success: true };
    } catch (e) {
      console.error('[NovumAI:Content] Mic capture failed:', e.name, e.message);
      return { success: false, error: e.message };
    }
  }

  function stopMicCapture() {
    if (micProcessorNode) {
      try { micProcessorNode.port.onmessage = null; } catch {}
      micProcessorNode.disconnect();
      micProcessorNode = null;
    }
    if (micMediaStream) {
      micMediaStream.getTracks().forEach((t) => t.stop());
      micMediaStream = null;
    }
    if (micAudioContext) {
      micAudioContext.close().catch(() => {});
      micAudioContext = null;
    }
    console.log('[NovumAI:Content] Mic capture stopped');
  }

  function getMicHealth() {
    const active = micMediaStream?.active ?? false;
    const live = micMediaStream?.getAudioTracks()[0]?.readyState === 'live';
    return active && live;
  }

  // ─── Message Listener ──────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Defense in depth — reject anything not from this extension
    if (sender.id !== chrome.runtime.id) return false;
    // Log incoming messages (except high-frequency ones like audio chunks and session state ticks)
    if (message.type !== 'SESSION_STATE' && message.type !== 'AUDIO_HEALTH') {
      console.log('[NovumAI:Content] Message received:', message.type, message.data ? Object.keys(message.data) : '');
    }
    switch (message.type) {
      case 'PING':
        // Readiness probe used by SW to decide whether to programmatically inject.
        sendResponse({ ready: true });
        return true;
      case 'SESSION_STARTED':
        console.log('[NovumAI:Content] ⚡ SESSION_STARTED — showing overlay');
        showOverlay();
        break;
      case 'SESSION_ENDED':
        hideOverlay();
        stopMicCapture();
        break;
      case 'START_MIC_CAPTURE':
        startMicCapture().then((result) => sendResponse(result));
        return true; // async sendResponse
      case 'STOP_MIC_CAPTURE':
        stopMicCapture();
        sendResponse({ success: true });
        return true;
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
      case 'QUOTA_WARNING': showQuotaWarning(message.data); break;
      case 'AUDIO_HEALTH':
        // Merge mic health from content script with tab health from offscreen
        message.data.micAudio = getMicHealth();
        updateAudioHealth(message.data);
        break;
      case 'CONNECTION_STATUS': updateConnectionStatus(message.data); break;
      case 'PROFILE_INCOMPLETE':
        const c = document.getElementById('novumai-suggestions');
        if (c) c.innerHTML = `<div class="novumai-empty"><span style="font-size:28px;margin-bottom:8px;display:block;opacity:0.5;">${ICONS.circleExclamation}</span><div>${escapeHtml(message.data.message)}</div></div>`;
        break;
    }
    sendResponse({ received: true });
    return true;
  });

  // ─── Init ───────────────────────────────────────────────────────────────

  createOverlay();
  console.log('[NovumAI] Content script loaded on Google Meet');

  // Check if a session is already active (handles race condition where
  // SESSION_STARTED was broadcast before content script was ready)
  chrome.runtime.sendMessage({ type: 'GET_SESSION_STATE' }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn('[NovumAI] Could not check session state:', chrome.runtime.lastError.message);
      return;
    }
    if (response?.hasActiveSession) {
      console.log('[NovumAI] Active session detected on load — showing overlay');
      showOverlay();
      if (response.elapsedSeconds) updateElapsed(response.elapsedSeconds);
      if (response.currentStage) updateStage(response.currentStage);
    }
  });
})();
