// NovumAI Extension - Background Service Worker
// Coordinates: auth, tab capture, WebSocket connections, message passing

import { CONFIG, getWsUrl, getEnvironment } from '../lib/config.js';
import { MSG } from '../lib/messages.js';
import { apiClient } from '../lib/api-client.js';
import { debug } from '../lib/debug.js';

const log = debug('SW');

// ─── State ───────────────────────────────────────────────────────────────────
// sessionState lives in SW module globals AND is mirrored to chrome.storage.session
// so we can rehydrate after SW suspension.

let sessionState = {
  isAuthenticated: false,
  user: null,
  company: null,
  activeSession: null, // { callConnectionId, startTime, tabId, wsConnectionId }
  currentStage: 'CALL_OPENING',
  businessMode: 'sales',
  contentMode: 'notes', // Matches frontend default (TranscriptContext) and backend default (realtime_sentiment_analysis)
  suggestionsEnabled: true,
  sequenceNumber: 0,
  lead: null,
  entityId: null,
  callDirection: 'outbound',
};

let backendWs = null;
let assemblyAiCustomerWs = null;
let assemblyAiAgentWs = null;
let retryQueue = [];
let offscreenCreated = false;
let offscreenCreatePromise = null;
let stateHydrated = false;

// ─── Persistence (chrome.storage.session survives SW suspension) ─────────────
// Only active-call state is persisted — user/company re-fetched from backend.

const PERSISTED_KEYS = [
  'activeSession',
  'currentStage',
  'businessMode',
  'contentMode',
  'suggestionsEnabled',
  'sequenceNumber',
  'lead',
  'entityId',
  'callDirection',
];

async function persistState() {
  if (!chrome.storage?.session) return;
  const snapshot = {};
  for (const k of PERSISTED_KEYS) snapshot[k] = sessionState[k];
  try {
    await chrome.storage.session.set({ novumai_session: snapshot });
  } catch (e) {
    log.warn('persistState failed:', e.message);
  }
}

async function hydrateState() {
  if (stateHydrated) return;
  stateHydrated = true;
  if (!chrome.storage?.session) return;
  try {
    const { novumai_session } = await chrome.storage.session.get('novumai_session');
    if (novumai_session) {
      for (const k of PERSISTED_KEYS) {
        if (novumai_session[k] !== undefined) sessionState[k] = novumai_session[k];
      }
      if (sessionState.activeSession) {
        log.info('Rehydrated active session from storage.session', {
          callConnectionId: sessionState.activeSession.callConnectionId,
        });
      }
    }
  } catch (e) {
    log.warn('hydrateState failed:', e.message);
  }
}

function elapsedFromStartTime() {
  const s = sessionState.activeSession;
  if (!s?.startTime) return 0;
  return Math.max(0, Math.floor((Date.now() - s.startTime) / 1000));
}

// ─── Auth ────────────────────────────────────────────────────────────────────

async function checkAuth() {
  // Cookie-based auth: fetch /api/users/me with credentials: include. A 401 from the
  // API is the authoritative signal — we no longer need chrome.cookies to probe first.
  try {
    log.info('Checking auth via /api/users/me');
    const [meResult, companyResult] = await Promise.allSettled([
      apiClient.getMe(),
      apiClient.getCompany(),
    ]);

    if (meResult.status === 'fulfilled' && meResult.value?.user_id) {
      sessionState.isAuthenticated = true;
      sessionState.user = meResult.value;
      sessionState.company = companyResult.status === 'fulfilled' ? companyResult.value : null;

      log.info('Auth verified', { userId: meResult.value.user_id, email: meResult.value.email });
      return {
        authenticated: true,
        user: sessionState.user,
        company: sessionState.company,
      };
    }

    log.warn('Not authenticated', { meStatus: meResult.status });
    sessionState.isAuthenticated = false;
    sessionState.user = null;
    sessionState.company = null;
    return { authenticated: false };
  } catch (e) {
    log.error('Auth check failed:', e.message);
    sessionState.isAuthenticated = false;
    sessionState.user = null;
    sessionState.company = null;
    return { authenticated: false };
  }
}

// ─── Offscreen Document ─────────────────────────────────────────────────────

async function ensureOffscreenDocument() {
  if (offscreenCreated) return;
  // De-dupe concurrent callers so two startSession calls don't both try to create
  if (offscreenCreatePromise) return offscreenCreatePromise;

  offscreenCreatePromise = (async () => {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('offscreen/offscreen.html')],
    });

    if (existingContexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen/offscreen.html',
        reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
        justification: 'Audio processing for real-time transcription',
      });
    }

    offscreenCreated = true;
  })().finally(() => {
    offscreenCreatePromise = null;
  });

  return offscreenCreatePromise;
}

async function closeOffscreenDocument() {
  if (!offscreenCreated) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch (e) {
    log.warn('closeOffscreenDocument failed:', e.message);
  }
  offscreenCreated = false;
}

// ─── Tab Capture ─────────────────────────────────────────────────────────────

async function startTabCapture(tabId) {
  try {
    let streamId;
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({
        targetTabId: tabId,
      });
    } catch (captureErr) {
      console.error('[NovumAI] getMediaStreamId failed:', captureErr);
      throw new Error(`Tab capture not available: ${captureErr.message}. Make sure you are on a Google Meet call.`);
    }

    if (!streamId) {
      throw new Error('Tab capture returned empty stream ID. Ensure the tab is active and has audio.');
    }

    await ensureOffscreenDocument();

    // Tell offscreen document to start capturing with this stream ID
    // Must await to ensure offscreen gets the message and starts capture
    const captureResult = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: MSG.START_AUDIO_CAPTURE,
          target: 'offscreen',
          data: { streamId, tabId },
        },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(response || { success: false, error: 'No response from offscreen' });
          }
        }
      );
    });

    if (!captureResult?.success) {
      throw new Error(`Audio capture failed in offscreen: ${captureResult?.error || 'Unknown error'}`);
    }

    console.log('[NovumAI] Tab capture started successfully with streamId:', streamId.substring(0, 20) + '...');
    return streamId;
  } catch (e) {
    console.error('[NovumAI] Tab capture failed:', e);
    throw e;
  }
}

function stopTabCapture() {
  try {
    chrome.runtime.sendMessage({
      type: MSG.STOP_AUDIO_CAPTURE,
      target: 'offscreen',
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[NovumAI] Stop capture message error:', chrome.runtime.lastError.message);
      }
    });
  } catch (e) {
    console.warn('[NovumAI] Stop capture failed:', e);
  }
}

// ─── AssemblyAI WebSocket ────────────────────────────────────────────────────

async function connectAssemblyAI(streamType) {
  try {
    const { token } = await apiClient.getAssemblyAIToken();

    const minSilence = streamType === 'customer'
      ? CONFIG.MIN_END_OF_TURN_SILENCE_CUSTOMER
      : CONFIG.MIN_END_OF_TURN_SILENCE_AGENT;

    const wsUrl = `${CONFIG.ASSEMBLYAI_WS_URL}?sample_rate=${CONFIG.SAMPLE_RATE}&encoding=${CONFIG.ENCODING}&token=${token}&min_end_of_turn_silence_when_confident=${minSilence}&max_turn_silence=${CONFIG.MAX_TURN_SILENCE}`;

    const ws = new WebSocket(wsUrl);

    // Wait for the connection to actually open before returning
    await new Promise((resolve, reject) => {
      ws.onopen = () => {
        console.log(`[NovumAI] AssemblyAI ${streamType} connected`);
        resolve();
      };
      ws.onerror = (e) => {
        console.error(`[NovumAI] AssemblyAI ${streamType} connection error:`, e);
        reject(new Error(`AssemblyAI ${streamType} WebSocket failed to connect`));
      };
    });

    // Set up ongoing handlers after connection
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleAssemblyAIMessage(streamType, msg);
      } catch (e) {
        console.error(`[NovumAI] AssemblyAI ${streamType} parse error:`, e);
      }
    };

    ws.onerror = (e) => {
      console.error(`[NovumAI] AssemblyAI ${streamType} error:`, e);
    };

    ws.onclose = (e) => {
      console.log(`[NovumAI] AssemblyAI ${streamType} closed: ${e.code}`);
      if (streamType === 'customer') assemblyAiCustomerWs = null;
      else assemblyAiAgentWs = null;
    };

    return ws;
  } catch (e) {
    console.error(`[NovumAI] AssemblyAI ${streamType} connection failed:`, e);
    throw e;
  }
}

function handleAssemblyAIMessage(streamType, msg) {
  if (msg.type !== 'Turn') return;

  const text = (typeof msg.transcript === 'string' ? msg.transcript : '').trim();
  if (!text) return;

  const isFinal = Boolean(msg.end_of_turn);
  const speaker = streamType === 'customer' ? 'Customer' : 'Agent';

  const audioStart = msg.words?.[0]?.start ? msg.words[0].start / 1000 : 0;
  const audioEnd = msg.words?.[msg.words.length - 1]?.end
    ? msg.words[msg.words.length - 1].end / 1000
    : 0;

  // Send partial to content script for live display
  broadcastToContent({
    type: isFinal ? MSG.TRANSCRIPT_FINAL : MSG.TRANSCRIPT_PARTIAL,
    data: { text, speaker, isFinal },
  });

  // On final, send to NovumAI backend
  if (isFinal) {
    sendTranscriptToBackend(text, speaker, audioStart, audioEnd);
  }
}

// ─── WebSocket Token Helpers ────────────────────────────────────────────────

function encodeWsSubprotocolToken(token) {
  // Match frontend: base64url encode, wrap as novum.<b64>
  const binary = new TextEncoder().encode(token);
  let b64 = '';
  for (let i = 0; i < binary.length; i++) {
    b64 += String.fromCharCode(binary[i]);
  }
  b64 = btoa(b64)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `novum.${b64}`;
}

async function fetchWsToken() {
  const { token } = await apiClient.getWebSocketToken();
  return token;
}

// ─── NovumAI Backend WebSocket ──────────────────────────────────────────────

let backendReconnectAttempts = 0;
let backendReconnectTimeoutId = null;
const BACKEND_RECONNECT_MAX_ATTEMPTS = 6;

function clearBackendReconnect() {
  if (backendReconnectTimeoutId !== null) {
    clearTimeout(backendReconnectTimeoutId);
    backendReconnectTimeoutId = null;
  }
}

async function connectBackendWs() {
  const wsUrl = await getWsUrl();
  const agentId = sessionState.user?.user_id;
  if (!agentId) throw new Error('No user ID for WebSocket connection');

  const wsToken = await fetchWsToken();
  const subprotocol = encodeWsSubprotocolToken(wsToken);

  const ws = new WebSocket(wsUrl, [subprotocol]);
  backendWs = ws;

  // Handshake — use once-listeners so later errors don't resolve this promise.
  await new Promise((resolve, reject) => {
    const onOpen = () => {
      ws.removeEventListener('error', onError);
      log.info('Backend WebSocket connected');
      backendReconnectAttempts = 0;
      flushRetryQueue();
      broadcastToContent({ type: MSG.CONNECTION_STATUS, data: { connected: true } });
      resolve();
    };
    const onError = () => {
      ws.removeEventListener('open', onOpen);
      reject(new Error('Backend WebSocket failed to connect'));
    };
    ws.addEventListener('open', onOpen, { once: true });
    ws.addEventListener('error', onError, { once: true });
  });

  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.connectionId && sessionState.activeSession) {
        sessionState.activeSession.wsConnectionId = msg.connectionId;
        persistState();
      }
      handleBackendMessage(msg);
    } catch (e) {
      log.error('Backend WS parse error:', e.message);
    }
  });

  ws.addEventListener('error', (e) => {
    log.error('Backend WS error', e?.message || '');
  });

  ws.addEventListener('close', (e) => {
    log.info(`Backend WS closed: ${e.code}`);
    if (backendWs === ws) backendWs = null;

    if (!sessionState.activeSession) return;

    if (backendReconnectAttempts >= BACKEND_RECONNECT_MAX_ATTEMPTS) {
      log.error('Backend WS reconnect attempts exhausted; ending session');
      broadcastToContent({
        type: MSG.CONNECTION_STATUS,
        data: { connected: false, code: e.code, reconnecting: false, exhausted: true },
      });
      return;
    }

    backendReconnectAttempts += 1;
    const delay = Math.min(3000 * 2 ** (backendReconnectAttempts - 1), 30000);
    broadcastToContent({
      type: MSG.CONNECTION_STATUS,
      data: { connected: false, code: e.code, reconnecting: true, attempt: backendReconnectAttempts },
    });

    clearBackendReconnect();
    backendReconnectTimeoutId = setTimeout(() => {
      backendReconnectTimeoutId = null;
      if (!sessionState.activeSession) return;
      connectBackendWs().catch((err) => log.error('Backend reconnect failed:', err.message));
    }, delay);
  });
}

function handleBackendMessage(msg) {
  const type = msg.type;

  if (type === 'transcript_analysis') {
    // Sentiment + stage update
    broadcastToContent({
      type: MSG.SENTIMENT_UPDATE,
      data: {
        label: msg.sentiment?.label || 'neutral',
        intensity: msg.sentiment?.intensity || 0,
        tone: msg.tone,
        speaker: msg.speaker,
      },
    });

    if (msg.current_stage && msg.current_stage !== sessionState.currentStage) {
      sessionState.currentStage = msg.current_stage;
      persistState();
      broadcastToContent({
        type: MSG.STAGE_UPDATE,
        data: { stage: msg.current_stage },
      });
    }
  } else if (type === 'next_best_response_streaming') {
    broadcastToContent({
      type: MSG.SUGGESTION_STREAMING,
      data: {
        suggestionId: msg.suggestion_id,
        status: msg.status, // 'started', 'chunk', 'completed'
        text: msg.text || '',
        contentMode: msg.content_mode,
      },
    });
  } else if (type === 'next_best_response') {
    broadcastToContent({
      type: MSG.SUGGESTION_COMPLETE,
      data: {
        businessMode: msg.business_mode,
        contentMode: msg.content_mode,
        responseType: msg.response_type,
        nextStage: msg.next_stage,
        suggestion: msg.next_best_response,
        suggestionId: msg.suggestion_id,
      },
    });

    if (msg.next_stage) {
      sessionState.currentStage = msg.next_stage;
      persistState();
    }
  } else if (type === 'SMART_SUGGESTIONS_LIMIT_REACHED') {
    broadcastToContent({
      type: MSG.QUOTA_EXCEEDED,
      data: { ...msg.payload, percentage: 100 },
    });
  } else if (type === 'QUOTA_WARNING') {
    broadcastToContent({
      type: MSG.QUOTA_WARNING,
      data: {
        percentage: msg.percentage,
        message: msg.message,
        remaining: msg.remaining,
      },
    });
  } else if (type === 'PROFILE_INCOMPLETE') {
    broadcastToContent({
      type: MSG.PROFILE_INCOMPLETE,
      data: { message: msg.message },
    });
  }
}

// ─── Send Transcript to Backend ──────────────────────────────────────────────

function sendTranscriptToBackend(text, speaker, audioStart, audioEnd) {
  if (!sessionState.activeSession) return;

  sessionState.sequenceNumber++;
  persistState();
  const messageId = crypto.randomUUID();

  const payload = {
    transcriptChunk: `${speaker}: ${text}`,
    timestamp: new Date().toISOString(),
    audioStart,
    audioEnd,
    wsConnectionId: sessionState.activeSession.wsConnectionId || '',
    callConnectionId: sessionState.activeSession.callConnectionId,
    customerId: sessionState.lead?.lead_id || sessionState.lead?.customer_number || '',
    leadId: sessionState.lead?.lead_id || '',
    entityId: sessionState.entityId || undefined,
    agentId: sessionState.user?.user_id,
    message_id: messageId,
    speaker,
    businessMode: sessionState.businessMode,
    contentMode: sessionState.contentMode,
    currentCallStage: sessionState.currentStage,
    lastSuggestionStage: sessionState.currentStage || '',
    callDirection: sessionState.callDirection || '',
    companyId: sessionState.company?.id || sessionState.user?.company_id || '',
    companyProfile: sessionState.company?.companyProfile || {},
    companyName: sessionState.company?.name || '',
    suggestionsEnabled: sessionState.suggestionsEnabled,
    plan: sessionState.company?.plan || {},
    activeSessionSeconds: elapsedFromStartTime(),
    sequence_number: sessionState.sequenceNumber,
  };

  const message = { type: 'ingest_transcript', payload };

  if (backendWs && backendWs.readyState === WebSocket.OPEN) {
    try {
      backendWs.send(JSON.stringify(message));
    } catch (e) {
      log.error('Failed to send transcript:', e.message);
      queueForRetry(payload);
    }
  } else {
    queueForRetry(payload);
  }
}

function queueForRetry(payload) {
  // Evict oldest (shift) rather than drop newest so sequence numbers stay as
  // contiguous as possible — the newest chunk is the one most likely to matter.
  if (retryQueue.length >= 100) retryQueue.shift();
  retryQueue.push({ payload, retries: 0, timestamp: Date.now() });
}

function flushRetryQueue() {
  if (!retryQueue.length || !backendWs || backendWs.readyState !== WebSocket.OPEN) return;

  const items = retryQueue;
  retryQueue = [];
  let dropped = 0;

  for (const item of items) {
    if (item.retries >= CONFIG.MAX_RETRIES) {
      dropped += 1;
      continue;
    }
    try {
      backendWs.send(JSON.stringify({ type: 'ingest_transcript', payload: item.payload }));
    } catch {
      retryQueue.push({ ...item, retries: item.retries + 1 });
    }
  }

  if (dropped > 0) log.warn(`Dropped ${dropped} transcript chunk(s) after MAX_RETRIES`);
}

// ─── Session Lifecycle ──────────────────────────────────────────────────────

async function startSession(tabId) {
  log.always('Starting session', { tabId, lead: sessionState.lead?.customer_number || 'none' });

  if (sessionState.activeSession) {
    throw new Error('Session already active');
  }

  if (!sessionState.isAuthenticated) {
    const auth = await checkAuth();
    if (!auth.authenticated) throw new Error('Not authenticated');
  }

  const callConnectionId = `ext-${crypto.randomUUID()}`;
  log.info('Call connection ID:', callConnectionId);

  // Reset per-session counters
  sessionState.sequenceNumber = 0;
  sessionState.currentStage = 'CALL_OPENING';

  // Set activeSession BEFORE connecting so reconnect + broadcast see the tabId
  sessionState.activeSession = {
    callConnectionId,
    startTime: Date.now(),
    tabId,
    wsConnectionId: '',
  };
  await persistState();

  let backendWsStarted = false;
  let tabCaptureStarted = false;
  let customerWsStarted = false;
  let agentWsStarted = false;

  try {
    log.info('Step 1/3: Connecting backend WebSocket...');
    await connectBackendWs();
    backendWsStarted = true;

    // Connect AssemblyAI BEFORE starting capture so audio has a target from sample 0.
    log.info('Step 2/3: Connecting AssemblyAI...');
    assemblyAiCustomerWs = await connectAssemblyAI('customer');
    customerWsStarted = true;
    assemblyAiAgentWs = await connectAssemblyAI('agent');
    agentWsStarted = true;

    log.info('Step 3/3: Starting tab capture...');
    await startTabCapture(tabId);
    tabCaptureStarted = true;

    // Mic capture in content script is non-fatal — session continues if user denies.
    broadcastToContent({ type: MSG.START_MIC_CAPTURE });
  } catch (e) {
    log.error('Session startup failed, rolling back:', e.message);

    if (agentWsStarted && assemblyAiAgentWs) {
      assemblyAiAgentWs.close();
      assemblyAiAgentWs = null;
    }
    if (customerWsStarted && assemblyAiCustomerWs) {
      assemblyAiCustomerWs.close();
      assemblyAiCustomerWs = null;
    }
    stopTabCapture();
    clearBackendReconnect();
    if (backendWsStarted && backendWs) {
      backendWs.close();
      backendWs = null;
    }

    sessionState.activeSession = null;
    await persistState();
    throw e;
  }

  // Create call record on backend (non-blocking).
  // Skip when no lead is attached — backend call_service.create_call() unconditionally
  // indexes call_data["customer_number"] which the router strips when null, causing a
  // 500. Transcripts still flow over the WS; record can be created later via endCall
  // (which accepts leadId retroactively).
  const customerNumber = sessionState.lead?.customer_number || null;
  if (customerNumber) {
    try {
      const callResponse = await apiClient.createCall({
        callConnectionId,
        direction: 'outbound',
        customerNumber,
        leadId: sessionState.lead?.lead_id || null,
        startTime: new Date().toISOString(),
      });
      if (callResponse?.entityId) {
        sessionState.entityId = callResponse.entityId;
        await persistState();
      }
    } catch (e) {
      log.warn('Call creation failed (non-blocking):', e.message);
    }
  } else {
    log.info('Skipping createCall — no lead/customer_number attached');
  }

  // Alarm drives periodic elapsed broadcasts + retry flush.
  // chrome.alarms minimum period is 30s in prod, but content script keeps its own
  // local 1s timer from activeSession.startTime for smooth countdown display.
  chrome.alarms.create('session-tick', { periodInMinutes: 0.5 });

  return { callConnectionId };
}

async function endSession() {
  if (!sessionState.activeSession) return;

  const { callConnectionId, startTime, tabId } = sessionState.activeSession;
  const durationSeconds = elapsedFromStartTime();

  // Kill the session-tick alarm first so it can't restart anything mid-teardown
  chrome.alarms.clear('session-tick').catch(() => {});

  // Stop audio capture
  stopTabCapture();
  broadcastToContent({ type: MSG.STOP_MIC_CAPTURE });

  if (assemblyAiCustomerWs) {
    assemblyAiCustomerWs.close();
    assemblyAiCustomerWs = null;
  }
  if (assemblyAiAgentWs) {
    assemblyAiAgentWs.close();
    assemblyAiAgentWs = null;
  }

  const summary = {
    callConnectionId,
    startTime,
    endTime: Date.now(),
    durationSeconds,
    stagesReached: sessionState.currentStage,
  };

  const endCallLeadId = sessionState.lead?.lead_id || null;
  const endCallLeadName = sessionState.lead
    ? `${sessionState.lead.first_name || ''} ${sessionState.lead.last_name || ''}`.trim() || null
    : null;
  const endCallEntityId = sessionState.entityId || null;
  const endCallTime = new Date().toISOString();

  // Clear activeSession BEFORE closing backend WS to prevent reconnect race
  sessionState.activeSession = null;
  sessionState.sequenceNumber = 0;
  sessionState.entityId = null;
  retryQueue = [];
  await persistState();

  clearBackendReconnect();

  try {
    await apiClient.endCall(callConnectionId, {
      status: 'ended',
      messageType: 'CALL_ENDED',
      endTime: endCallTime,
      leadId: endCallLeadId,
      leadName: endCallLeadName,
      entityId: endCallEntityId,
    });
  } catch (e) {
    log.warn('Call end API failed:', e.message);
  }

  if (backendWs) {
    backendWs.close();
    backendWs = null;
  }

  await closeOffscreenDocument();

  await chrome.storage.local.set({ lastSession: summary });

  const env = await getEnvironment();
  const webappBase = env === 'production' ? CONFIG.WEBAPP_URL_PROD : CONFIG.WEBAPP_URL_DEV;
  const analyticsUrl = `${webappBase}/call-analytics/${callConnectionId}`;
  chrome.tabs.create({ url: analyticsUrl, active: false });

  // Target the actual session tab — not a broad query.
  if (tabId) {
    chrome.tabs.sendMessage(tabId, { type: MSG.SESSION_ENDED, data: summary }).catch(() => {});
  }

  return summary;
}

// ─── Content Script Communication ───────────────────────────────────────────
// Prefer the stored session tabId when we have an active session. Fall back to a
// Meet-URL query only when there is no active session (rare — state-independent
// broadcasts like CONNECTION_STATUS during a reconnect attempt before start).

// Ping the tab to see if the content script is alive; if not, programmatically
// inject it. Required because declarative content_scripts do NOT auto-inject into
// tabs that were already open when the extension was (re)loaded — a common cause
// of "Could not establish connection. Receiving end does not exist."
async function ensureContentScriptLoaded(tabId) {
  // Using log.always so diagnostics are visible without enabling novumai_debug.
  // Can be demoted once stable.
  let tabInfo = null;
  try {
    tabInfo = await chrome.tabs.get(tabId);
  } catch (e) {
    log.error(`ensureContentScriptLoaded: tab ${tabId} not found:`, e.message);
    return false;
  }
  log.always(`ensureContentScriptLoaded: tab ${tabId} url=${tabInfo.url?.substring(0, 80)} status=${tabInfo.status}`);

  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (pong?.ready) {
      log.always(`Content script already loaded in tab ${tabId}`);
      return true;
    }
  } catch (e) {
    log.always(`Pre-inject PING failed (${e.message}) — will inject`);
  }

  if (!chrome.scripting?.executeScript) {
    log.error('chrome.scripting unavailable — check manifest "scripting" permission + remove & re-add extension');
    return false;
  }

  try {
    log.always(`Injecting content.js into tab ${tabId} (ISOLATED world, all frames)`);
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'ISOLATED',
      files: ['content/content.js'],
    });
    log.always(`executeScript returned ${results?.length || 0} result(s):`, JSON.stringify(
      results?.map((r) => ({
        frameId: r.frameId,
        documentId: r.documentId?.substring(0, 8),
        hasResult: r.result !== undefined,
        error: r.error?.message,
      })) || [],
    ));

    try {
      await chrome.scripting.insertCSS({
        target: { tabId, allFrames: true },
        files: ['content/overlay.css'],
      });
    } catch (e) {
      log.warn(`insertCSS failed (non-fatal):`, e.message);
    }

    // Give the listener a tick to register before any broadcast.
    await new Promise((r) => setTimeout(r, 300));

    try {
      const verify = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      if (verify?.ready) {
        log.always(`Post-inject PING succeeded for tab ${tabId}`);
        return true;
      }
      log.warn(`Post-inject PING returned non-ready:`, JSON.stringify(verify));
    } catch (e) {
      log.warn(`Post-inject PING failed for tab ${tabId}:`, e.message);
    }
    return false;
  } catch (e) {
    log.error(`executeScript threw for tab ${tabId}:`, e.message, e.stack);
    return false;
  }
}

function broadcastToContent(message, retries = 0) {
  const sessionTabId = sessionState.activeSession?.tabId;
  if (sessionTabId) {
    chrome.tabs.sendMessage(sessionTabId, message).catch((err) => {
      const isCritical = message.type === MSG.SESSION_STARTED || message.type === MSG.SESSION_ENDED;
      if (isCritical && retries < 3) {
        setTimeout(() => broadcastToContent(message, retries + 1), 500);
      } else {
        log.warn(`Broadcast to tab ${sessionTabId} failed:`, err.message);
      }
    });
    return;
  }

  // No session → fall back to URL query (only for pre-session broadcasts)
  chrome.tabs.query({ url: 'https://meet.google.com/*' }, (tabs) => {
    if (tabs.length === 0 && retries < 3 && message.type === MSG.SESSION_STARTED) {
      setTimeout(() => broadcastToContent(message, retries + 1), 500);
      return;
    }
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  });
}

// ─── Audio Data Routing ─────────────────────────────────────────────────────

function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

function handleAudioChunk(streamType, audioData) {
  const ws = streamType === 'customer' ? assemblyAiCustomerWs : assemblyAiAgentWs;
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      // audioData comes as base64 string from offscreen (ArrayBuffer can't survive sendMessage)
      const buffer = typeof audioData === 'string' ? base64ToArrayBuffer(audioData) : audioData;
      ws.send(buffer);
    } catch (e) {
      console.error(`[NovumAI] Failed to send ${streamType} audio chunk:`, e);
    }
  }
}

// ─── Message Listener ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Reject messages from anywhere other than this extension. Web pages cannot
  // reach this listener without externally_connectable (not declared), but defense
  // in depth — this guards future additions.
  if (sender.id !== chrome.runtime.id) return false;

  // Ignore messages not addressed to background
  if (message.target && message.target !== 'background') return false;

  const handler = messageHandlers[message.type];
  if (!handler) return false;

  // Ensure state is rehydrated before handling (SW may have just woken up)
  hydrateState().then(() => handler(message, sender, sendResponse));
  return true; // async response
});

// Flatten a lead-like response into the shape the popup uses
// (first_name, last_name, customer_number, company_name, ...).
//
// Accepts three shapes — the popup is source-agnostic, so we normalise here:
//   1. Nested Unified Lead DTO: { core: {...}, local_fields: {...} } — from
//      POST /api/leads/ and GET /api/leads/phone/.
//   2. Flat entity hit from /api/crm/entities/search: { entity_id, entity_type,
//      source_type, first_name, last_name, email, phone, company, ... }.
//   3. Already flat (e.g. an object produced by a prior flattenLead call).
function flattenLead(raw) {
  if (!raw) return raw;

  // Unified entity shape from /crm/entities/search
  if (raw.entity_id && raw.entity_type) {
    const idParts = String(raw.entity_id).split(':');
    const rawId = idParts.length > 1 ? idParts.slice(1).join(':') : raw.entity_id;
    return {
      lead_id: rawId,
      entity_id: raw.entity_id,
      entity_type: raw.entity_type,
      source: raw.source_type || null,
      first_name: raw.first_name || null,
      last_name: raw.last_name || null,
      email: raw.email || null,
      customer_number: raw.phone || null,
      company_name: raw.company || null,
      job_title: null,
      status: null,
      tags: [],
      notes: null,
      created_at: null,
    };
  }

  // Unified Lead DTO { core, local_fields, salesforce_fields }
  if (raw.core) {
    const c = raw.core || {};
    const lf = raw.local_fields || {};
    return {
      lead_id: c.id || lf.lead_id,
      first_name: c.first_name || null,
      last_name: c.last_name || null,
      email: c.email || null,
      customer_number: lf.customer_number || c.phone || null,
      company_name: c.company || lf.company_name || null,
      job_title: lf.job_title || null,
      source: lf.source || c.source_type || null,
      status: c.status || null,
      tags: c.tags || [],
      notes: c.notes || null,
      created_at: c.created_at || null,
    };
  }

  return raw; // already flat
}

const messageHandlers = {
  [MSG.CHECK_AUTH]: async (msg, sender, sendResponse) => {
    const result = await checkAuth();
    sendResponse(result);
  },

  [MSG.START_SESSION]: async (msg, sender, sendResponse) => {
    try {
      const tabId = msg.data?.tabId;
      if (!tabId) throw new Error('No tab ID provided');
      log.event('START_SESSION received', { tabId, hasLead: !!msg.data?.lead });

      // Store lead data if provided
      if (msg.data?.lead) {
        sessionState.lead = msg.data.lead;
        log.info('Lead attached to session', { leadId: msg.data.lead.lead_id, phone: msg.data.lead.customer_number });
      }

      // Inject content script if the Meet tab was already open when the extension
      // was (re)loaded — declarative content_scripts don't retro-inject.
      await ensureContentScriptLoaded(tabId);

      const result = await startSession(tabId);
      log.always('Session started successfully', result);
      sendResponse({ success: true, ...result });
      broadcastToContent({ type: MSG.SESSION_STARTED, data: result });
    } catch (e) {
      log.error('Start session error:', e.message);
      sendResponse({ success: false, error: e.message });
    }
  },

  [MSG.END_SESSION]: async (msg, sender, sendResponse) => {
    try {
      const summary = await endSession();
      sendResponse({ success: true, summary });
    } catch (e) {
      console.error('[NovumAI] End session error:', e);
      sendResponse({ success: false, error: e.message });
    }
  },

  [MSG.GET_SESSION_STATE]: (msg, sender, sendResponse) => {
    sendResponse({
      isAuthenticated: sessionState.isAuthenticated,
      user: sessionState.user,
      company: sessionState.company,
      hasActiveSession: !!sessionState.activeSession,
      activeSession: sessionState.activeSession,
      elapsedSeconds: elapsedFromStartTime(),
      currentStage: sessionState.currentStage,
      businessMode: sessionState.businessMode,
      contentMode: sessionState.contentMode,
      suggestionsEnabled: sessionState.suggestionsEnabled,
      lead: sessionState.lead,
    });
  },

  [MSG.TAB_AUDIO_CHUNK]: (msg) => {
    if (msg.data?.audioData) {
      handleAudioChunk('customer', msg.data.audioData);
    }
  },

  [MSG.MIC_AUDIO_CHUNK]: (msg) => {
    if (msg.data?.audioData) {
      handleAudioChunk('agent', msg.data.audioData);
    }
  },

  [MSG.SET_BUSINESS_MODE]: (msg, sender, sendResponse) => {
    sessionState.businessMode = msg.data?.businessMode || 'sales';
    persistState();
    sendResponse({ success: true });
  },

  [MSG.SET_CONTENT_MODE]: (msg, sender, sendResponse) => {
    sessionState.contentMode = msg.data?.contentMode || 'notes';
    persistState();
    sendResponse({ success: true });
  },

  [MSG.SET_SUGGESTIONS_ENABLED]: (msg, sender, sendResponse) => {
    sessionState.suggestionsEnabled = msg.data?.enabled ?? true;
    persistState();
    sendResponse({ success: true });
  },

  [MSG.OFFSCREEN_READY]: (msg, sender, sendResponse) => {
    console.log('[NovumAI] Offscreen document ready');
    sendResponse({ success: true });
  },

  [MSG.MIC_PERMISSION_GRANTED]: (msg, sender, sendResponse) => {
    log.always('Microphone permission granted by user');
    sendResponse({ success: true });
  },

  // Unified CRM entity search (/api/crm/entities/search). Returns
  // { entities: [{ entity_id, entity_type, source_type, first_name, ... }] }.
  // flattenLead handles the shape; the popup stays source-agnostic.
  [MSG.SEARCH_LEADS]: async (msg, sender, sendResponse) => {
    const query = msg.data.query || msg.data.phoneNumber || '';
    log.info('Searching leads:', query);
    try {
      const result = await apiClient.searchLeads(query);
      const rawEntities = result?.entities || result?.leads || [];
      const leads = rawEntities.map(flattenLead);
      log.info('Lead search result:', { count: leads.length });
      if (leads.length === 1) {
        // Single match — auto-select
        sendResponse({ success: true, lead: leads[0], leads });
      } else if (leads.length > 1) {
        // Multiple matches — let popup show list
        sendResponse({ success: true, lead: null, leads });
      } else {
        sendResponse({ success: true, lead: null, leads: [] });
      }
    } catch (e) {
      log.error('Lead search failed:', e.message);
      sendResponse({ success: false, error: e.message });
    }
  },

  [MSG.CREATE_LEAD]: async (msg, sender, sendResponse) => {
    log.info('Creating lead:', { name: `${msg.data.first_name} ${msg.data.last_name}`, phone: msg.data.customer_number });
    try {
      const result = await apiClient.createLead(msg.data);
      const lead = flattenLead(result);
      log.info('Lead created:', { leadId: lead?.id });
      sendResponse({ success: true, lead });
    } catch (e) {
      log.error('Lead creation failed:', e.message);
      sendResponse({ success: false, error: e.message });
    }
  },

  [MSG.SET_LEAD]: (msg, sender, sendResponse) => {
    sessionState.lead = msg.data?.lead || null;
    persistState();
    log.info('Lead set:', sessionState.lead ? { leadId: sessionState.lead.lead_id, phone: sessionState.lead.customer_number } : 'cleared');
    sendResponse({ success: true });
  },

  // Audio health (forwarded from offscreen to content script)
  [MSG.AUDIO_HEALTH]: (msg) => {
    broadcastToContent({
      type: MSG.AUDIO_HEALTH,
      data: msg.data,
    });
  },
};

// ─── Initialization ─────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  log.always('Extension installed');
  // Clear any stale session storage from a previous install
  try { await chrome.storage.session.clear(); } catch {}
});

chrome.runtime.onStartup.addListener(() => {
  log.info('Browser startup — clearing stale session state');
  chrome.storage.session.clear().catch(() => {});
});

// Rehydrate on any SW wake — top-level code runs on every start.
hydrateState().catch((e) => log.warn('Initial hydrate failed:', e.message));

// Alarm handler — fires every 30s while a session is active. Drives retry flush
// and keeps the SW warm. Must be registered at top level so it survives SW restarts.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'session-tick') return;
  await hydrateState();
  if (!sessionState.activeSession) {
    chrome.alarms.clear('session-tick').catch(() => {});
    return;
  }
  flushRetryQueue();
  // Ping backend WS as a keep-alive (backend ignores unknown types gracefully)
  if (backendWs?.readyState === WebSocket.OPEN) {
    try { backendWs.send(JSON.stringify({ type: 'ping' })); } catch {}
  }
});

// Best-effort graceful persist on suspend
chrome.runtime.onSuspend.addListener(() => {
  // onSuspend must be synchronous — fire-and-forget the persist
  persistState();
});
