// NovumAI Extension - Background Service Worker
// Coordinates: auth, tab capture, WebSocket connections, message passing

import { CONFIG, getApiBaseUrl, getWsUrl, getEnvironment } from '../lib/config.js';
import { MSG } from '../lib/messages.js';
import { apiClient } from '../lib/api-client.js';
import { debug } from '../lib/debug.js';

const log = debug('SW');

// ─── State ───────────────────────────────────────────────────────────────────

let sessionState = {
  isAuthenticated: false,
  user: null,
  company: null,
  activeSession: null, // { callConnectionId, startTime, tabId, wsConnectionId }
  currentStage: 'CALL_OPENING',
  businessMode: 'sales',
  contentMode: 'bullets',
  suggestionsEnabled: true,
  sequenceNumber: 0,
  elapsedSeconds: 0,
  lead: null, // { lead_id, first_name, last_name, company_name, customer_number, ... }
  entityId: null, // Captured from createCall response (unified CRM entity)
  callDirection: 'outbound', // Extension calls are always outbound
};

let backendWs = null;
let assemblyAiCustomerWs = null;
let assemblyAiAgentWs = null;
let elapsedTimer = null;
let retryPollTimer = null;
let retryQueue = [];
let offscreenCreated = false;

// ─── Auth ────────────────────────────────────────────────────────────────────

async function checkAuth() {
  try {
    log.info('Checking auth...');
    const cookie = await apiClient.getSessionCookie();
    if (!cookie) {
      log.info('No session cookie found');
      sessionState.isAuthenticated = false;
      sessionState.user = null;
      sessionState.company = null;
      return { authenticated: false };
    }
    log.info('Session cookie found, verifying with API...');

    const [meResult, companyResult] = await Promise.allSettled([
      apiClient.getMe(),
      apiClient.getCompany(),
    ]);

    // /api/users/me returns user object directly (with user_id field)
    if (meResult.status === 'fulfilled' && meResult.value?.user_id) {
      sessionState.isAuthenticated = true;
      sessionState.user = meResult.value;

      if (companyResult.status === 'fulfilled') {
        sessionState.company = companyResult.value;
      }

      log.info('Auth verified', { userId: meResult.value.user_id, email: meResult.value.email });
      return {
        authenticated: true,
        user: sessionState.user,
        company: sessionState.company,
      };
    }

    log.warn('Auth API call failed or no user_id', { meResult: meResult.status, meValue: meResult.value });
    sessionState.isAuthenticated = false;
    sessionState.user = null;
    sessionState.company = null;
    return { authenticated: false };
  } catch (e) {
    log.error('Auth check failed:', e);
    sessionState.isAuthenticated = false;
    sessionState.user = null;
    sessionState.company = null;
    return { authenticated: false };
  }
}

// ─── Offscreen Document ─────────────────────────────────────────────────────

async function ensureOffscreenDocument() {
  if (offscreenCreated) return;

  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('offscreen/offscreen.html')],
  });

  if (existingContexts.length > 0) {
    offscreenCreated = true;
    return;
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Audio processing for real-time transcription',
  });

  offscreenCreated = true;
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

async function connectBackendWs() {
  const wsUrl = await getWsUrl();
  const agentId = sessionState.user?.user_id;
  if (!agentId) throw new Error('No user ID for WebSocket connection');

  // Fetch a fresh HMAC token and encode as subprotocol
  const wsToken = await fetchWsToken();
  const subprotocol = encodeWsSubprotocolToken(wsToken);

  backendWs = new WebSocket(wsUrl, [subprotocol]);

  // Wait for backend WS to actually open
  await new Promise((resolve, reject) => {
    backendWs.onopen = () => {
      console.log('[NovumAI] Backend WebSocket connected (token auth)');
      flushRetryQueue();
      broadcastToContent({
        type: MSG.CONNECTION_STATUS,
        data: { connected: true },
      });
      resolve();
    };
    backendWs.onerror = (e) => {
      console.error('[NovumAI] Backend WS connection error:', e);
      reject(new Error('Backend WebSocket failed to connect'));
    };
  });

  // Set up ongoing handlers after connection
  backendWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      // Capture connectionId from initial message
      if (msg.connectionId && sessionState.activeSession) {
        sessionState.activeSession.wsConnectionId = msg.connectionId;
        console.log('[NovumAI] Backend WS connectionId:', msg.connectionId);
      }

      handleBackendMessage(msg);
    } catch (e) {
      console.error('[NovumAI] Backend WS parse error:', e);
    }
  };

  backendWs.onerror = (e) => {
    console.error('[NovumAI] Backend WS error:', e);
  };

  backendWs.onclose = (e) => {
    console.log(`[NovumAI] Backend WS closed: ${e.code}`);
    backendWs = null;

    // Auto-reconnect if session is active (fetches a fresh token)
    if (sessionState.activeSession) {
      broadcastToContent({
        type: MSG.CONNECTION_STATUS,
        data: { connected: false, code: e.code, reconnecting: true },
      });
      setTimeout(() => connectBackendWs(), 3000);
    }
  };
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
    activeSessionSeconds: sessionState.elapsedSeconds,
    sequence_number: sessionState.sequenceNumber,
  };

  const message = { type: 'ingest_transcript', payload };

  if (backendWs && backendWs.readyState === WebSocket.OPEN) {
    try {
      backendWs.send(JSON.stringify(message));
    } catch (e) {
      console.error('[NovumAI] Failed to send transcript:', e);
      queueForRetry(payload);
    }
  } else {
    queueForRetry(payload);
  }
}

function queueForRetry(payload) {
  if (retryQueue.length < 100) {
    retryQueue.push({ payload, retries: 0, timestamp: Date.now() });
  }
}

function flushRetryQueue() {
  if (!retryQueue.length || !backendWs || backendWs.readyState !== WebSocket.OPEN) return;

  const items = [...retryQueue];
  retryQueue = [];

  for (const item of items) {
    if (item.retries < CONFIG.MAX_RETRIES) {
      try {
        backendWs.send(JSON.stringify({ type: 'ingest_transcript', payload: item.payload }));
      } catch {
        retryQueue.push({ ...item, retries: item.retries + 1 });
      }
    }
  }
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

  // Reset state
  sessionState.sequenceNumber = 0;
  sessionState.elapsedSeconds = 0;
  sessionState.currentStage = 'CALL_OPENING';

  // Track what we've started so we can roll back on failure
  let backendWsStarted = false;
  let tabCaptureStarted = false;
  let customerWsStarted = false;
  let agentWsStarted = false;

  try {
    // 1. Connect backend WebSocket
    log.info('Step 1/3: Connecting backend WebSocket...');
    await connectBackendWs();
    backendWsStarted = true;
    log.info('Step 1/3: ✓ Backend WS connected');

    // 2. Start tab capture → offscreen audio processing
    log.info('Step 2/3: Starting tab capture...');
    await startTabCapture(tabId);
    tabCaptureStarted = true;
    log.info('Step 2/3: ✓ Tab capture started');

    // 2b. Start mic capture in content script (non-blocking — mic failure is non-fatal)
    log.info('Step 2b: Starting mic capture in content script...');
    broadcastToContent({ type: MSG.START_MIC_CAPTURE });
    log.info('Step 2b: Mic capture request sent to content script');

    // 3. Connect AssemblyAI for both streams
    log.info('Step 3/3: Connecting AssemblyAI...');
    assemblyAiCustomerWs = await connectAssemblyAI('customer');
    customerWsStarted = true;
    log.info('Step 3/3: ✓ AssemblyAI customer connected');
    assemblyAiAgentWs = await connectAssemblyAI('agent');
    agentWsStarted = true;
    log.info('Step 3/3: ✓ AssemblyAI agent connected');
  } catch (e) {
    // Roll back any resources that were started
    log.error('Session startup failed, rolling back:', e.message);
    log.info('Rollback state:', { backendWsStarted, tabCaptureStarted, customerWsStarted, agentWsStarted });

    if (agentWsStarted && assemblyAiAgentWs) {
      assemblyAiAgentWs.close();
      assemblyAiAgentWs = null;
    }
    if (customerWsStarted && assemblyAiCustomerWs) {
      assemblyAiCustomerWs.close();
      assemblyAiCustomerWs = null;
    }
    // Always send stop to offscreen to release any held streams/contexts
    // This prevents "Cannot capture a tab with an active stream" on retry
    stopTabCapture();
    if (backendWsStarted && backendWs) {
      backendWs.close();
      backendWs = null;
    }

    throw e;
  }

  // 4. Create call record on backend (non-blocking)
  try {
    const callResponse = await apiClient.createCall({
      callConnectionId,
      direction: 'outbound',
      customerNumber: sessionState.lead?.customer_number || null,
      leadId: sessionState.lead?.lead_id || null,
      startTime: new Date().toISOString(),
    });
    // Capture entityId from backend response for transcript payloads and endCall
    if (callResponse?.entityId) {
      sessionState.entityId = callResponse.entityId;
    }
  } catch (e) {
    console.warn('[NovumAI] Call creation failed (non-blocking):', e);
  }

  // 5. Start elapsed timer
  elapsedTimer = setInterval(() => {
    sessionState.elapsedSeconds++;
    broadcastToContent({
      type: MSG.SESSION_STATE,
      data: { elapsedSeconds: sessionState.elapsedSeconds },
    });
  }, 1000);

  sessionState.activeSession = {
    callConnectionId,
    startTime: Date.now(),
    tabId,
    wsConnectionId: '',
  };

  // 6. Retry queue polling (store ref so we can clear it on session end)
  if (retryPollTimer) clearInterval(retryPollTimer);
  retryPollTimer = setInterval(() => {
    if (retryQueue.length > 0 && backendWs?.readyState === WebSocket.OPEN) {
      flushRetryQueue();
    }
  }, CONFIG.RETRY_POLL_INTERVAL_MS);

  return { callConnectionId };
}

async function endSession() {
  if (!sessionState.activeSession) return;

  const { callConnectionId } = sessionState.activeSession;

  // Stop timer
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }

  // Stop audio capture
  stopTabCapture();
  broadcastToContent({ type: MSG.STOP_MIC_CAPTURE });

  // Close AssemblyAI connections
  if (assemblyAiCustomerWs) {
    assemblyAiCustomerWs.close();
    assemblyAiCustomerWs = null;
  }
  if (assemblyAiAgentWs) {
    assemblyAiAgentWs.close();
    assemblyAiAgentWs = null;
  }

  // Build session summary BEFORE clearing activeSession
  const summary = {
    callConnectionId,
    startTime: sessionState.activeSession.startTime,
    endTime: Date.now(),
    durationSeconds: sessionState.elapsedSeconds,
    stagesReached: sessionState.currentStage,
  };

  // Capture values needed for endCall before clearing state
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

  // Clear retry poll timer
  if (retryPollTimer) {
    clearInterval(retryPollTimer);
    retryPollTimer = null;
  }

  // End call on backend
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
    console.warn('[NovumAI] Call end API failed:', e);
  }

  // Close backend WebSocket (activeSession is already null so onclose won't reconnect)
  if (backendWs) {
    backendWs.close();
    backendWs = null;
  }

  await chrome.storage.local.set({ lastSession: summary });

  // Open post-call analytics on the webapp
  const env = await getEnvironment();
  const webappBase = env === 'production' ? CONFIG.WEBAPP_URL_PROD : CONFIG.WEBAPP_URL_DEV;
  const analyticsUrl = `${webappBase}/call-analytics/${callConnectionId}`;
  chrome.tabs.create({ url: analyticsUrl });

  broadcastToContent({ type: MSG.SESSION_ENDED, data: summary });

  return summary;
}

// ─── Content Script Communication ───────────────────────────────────────────

function broadcastToContent(message, retries = 0) {
  chrome.tabs.query({ url: 'https://meet.google.com/*' }, (tabs) => {
    if (tabs.length === 0 && retries < 3) {
      // Content script tab not found yet, retry after a short delay
      setTimeout(() => broadcastToContent(message, retries + 1), 500);
      return;
    }
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch((err) => {
        // Content script may not be ready yet — retry once for critical messages
        if (retries < 2 && (message.type === MSG.SESSION_STARTED || message.type === MSG.SESSION_ENDED)) {
          console.warn(`[NovumAI] Broadcast to tab ${tab.id} failed, retrying:`, err.message);
          setTimeout(() => {
            chrome.tabs.sendMessage(tab.id, message).catch(() => {});
          }, 1000);
        }
      });
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
  // Ignore messages not for background
  if (message.target && message.target !== 'background') return false;

  const handler = messageHandlers[message.type];
  if (handler) {
    handler(message, sender, sendResponse);
    return true; // Async response
  }

  return false;
});

// Flatten nested lead API response { core: {...}, local_fields: {...} } into
// a flat object the popup can use (e.g. lead.first_name, lead.company_name).
// If the lead is already flat (e.g. from CREATE_LEAD), return it unchanged.
function flattenLead(raw) {
  if (!raw || !raw.core) return raw; // already flat or null
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
      elapsedSeconds: sessionState.elapsedSeconds,
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
    sendResponse({ success: true });
  },

  [MSG.SET_CONTENT_MODE]: (msg, sender, sendResponse) => {
    sessionState.contentMode = msg.data?.contentMode || 'bullets';
    sendResponse({ success: true });
  },

  [MSG.SET_SUGGESTIONS_ENABLED]: (msg, sender, sendResponse) => {
    sessionState.suggestionsEnabled = msg.data?.enabled ?? true;
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

  // Leads — uses general search endpoint (partial match on phone/name/email/company)
  // API returns nested { core: {...}, local_fields: {...} } — flatten for popup consumption.
  [MSG.SEARCH_LEADS]: async (msg, sender, sendResponse) => {
    const query = msg.data.query || msg.data.phoneNumber || '';
    log.info('Searching leads:', query);
    try {
      const result = await apiClient.searchLeads(query);
      // The general endpoint returns { leads: [...], total_count, last_key }
      const rawLeads = result?.leads || [];
      const leads = rawLeads.map(flattenLead);
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
  console.log('[NovumAI] Extension installed');
});

// Check auth on startup
checkAuth().then((result) => {
  console.log('[NovumAI] Initial auth check:', result.authenticated ? 'authenticated' : 'not authenticated');
});
