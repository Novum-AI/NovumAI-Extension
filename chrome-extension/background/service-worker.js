// NovumAI Extension - Background Service Worker
// Coordinates: auth, tab capture, WebSocket connections, message passing

import { CONFIG, getApiBaseUrl, getWsUrl, getEnvironment } from '../lib/config.js';
import { MSG } from '../lib/messages.js';
import { apiClient } from '../lib/api-client.js';

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
    const cookie = await apiClient.getSessionCookie();
    if (!cookie) {
      sessionState.isAuthenticated = false;
      sessionState.user = null;
      sessionState.company = null;
      return { authenticated: false };
    }

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

      return {
        authenticated: true,
        user: sessionState.user,
        company: sessionState.company,
      };
    }

    sessionState.isAuthenticated = false;
    sessionState.user = null;
    sessionState.company = null;
    return { authenticated: false };
  } catch (e) {
    console.error('[NovumAI] Auth check failed:', e);
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

// ─── NovumAI Backend WebSocket ──────────────────────────────────────────────

async function connectBackendWs() {
  const wsUrl = await getWsUrl();
  const agentId = sessionState.user?.user_id;
  if (!agentId) throw new Error('No user ID for WebSocket connection');

  const fullUrl = `${wsUrl}?agentID=${agentId}`;

  backendWs = new WebSocket(fullUrl);

  // Wait for backend WS to actually open
  await new Promise((resolve, reject) => {
    backendWs.onopen = () => {
      console.log('[NovumAI] Backend WebSocket connected');
      flushRetryQueue();
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

    // Auto-reconnect if session is active
    if (sessionState.activeSession) {
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
      data: msg.payload,
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
    customerId: 'extension-call',
    agentId: sessionState.user?.user_id,
    message_id: messageId,
    speaker,
    businessMode: sessionState.businessMode,
    contentMode: sessionState.contentMode,
    currentCallStage: sessionState.currentStage,
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
  if (sessionState.activeSession) {
    throw new Error('Session already active');
  }

  if (!sessionState.isAuthenticated) {
    const auth = await checkAuth();
    if (!auth.authenticated) throw new Error('Not authenticated');
  }

  const callConnectionId = `ext-${crypto.randomUUID()}`;

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
    await connectBackendWs();
    backendWsStarted = true;

    // 2. Start tab capture → offscreen audio processing
    await startTabCapture(tabId);
    tabCaptureStarted = true;

    // 3. Connect AssemblyAI for both streams
    assemblyAiCustomerWs = await connectAssemblyAI('customer');
    customerWsStarted = true;
    assemblyAiAgentWs = await connectAssemblyAI('agent');
    agentWsStarted = true;
  } catch (e) {
    // Roll back any resources that were started
    console.error('[NovumAI] Session startup failed, rolling back:', e);

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
    await apiClient.createCall({
      callConnectionId,
      direction: 'outbound',
      customer_number: 'extension-call',
      start_time: new Date().toISOString(),
    });
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

  // Clear activeSession BEFORE closing backend WS to prevent reconnect race
  sessionState.activeSession = null;
  sessionState.sequenceNumber = 0;
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
      message_type: 'CALL_ENDED',
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
  const webappBase = env === 'production'
    ? CONFIG.WEBAPP_URL_PROD
    : CONFIG.WEBAPP_URL_DEV;
  const analyticsUrl = `${webappBase}/call-analytics/${callConnectionId}`;
  chrome.tabs.create({ url: analyticsUrl });

  broadcastToContent({ type: MSG.SESSION_ENDED, data: summary });

  return summary;
}

// ─── Content Script Communication ───────────────────────────────────────────

function broadcastToContent(message) {
  chrome.tabs.query({ url: 'https://meet.google.com/*' }, (tabs) => {
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
  // Ignore messages not for background
  if (message.target && message.target !== 'background') return false;

  const handler = messageHandlers[message.type];
  if (handler) {
    handler(message, sender, sendResponse);
    return true; // Async response
  }

  return false;
});

const messageHandlers = {
  [MSG.CHECK_AUTH]: async (msg, sender, sendResponse) => {
    const result = await checkAuth();
    sendResponse(result);
  },

  [MSG.START_SESSION]: async (msg, sender, sendResponse) => {
    try {
      const tabId = msg.data?.tabId;
      if (!tabId) throw new Error('No tab ID provided');
      const result = await startSession(tabId);
      sendResponse({ success: true, ...result });
      broadcastToContent({ type: MSG.SESSION_STARTED, data: result });
    } catch (e) {
      console.error('[NovumAI] Start session error:', e);
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
};

// ─── Initialization ─────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[NovumAI] Extension installed');
});

// Check auth on startup
checkAuth().then((result) => {
  console.log('[NovumAI] Initial auth check:', result.authenticated ? 'authenticated' : 'not authenticated');
});
