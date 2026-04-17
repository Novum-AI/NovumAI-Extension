// NovumAI Offscreen Document
// Handles TAB audio capture and PCM16 conversion
// Runs in an offscreen document because service workers can't use AudioContext
// NOTE: Mic capture is handled by the content script (not here) because
// getUserMedia in offscreen docs can't trigger the browser permission prompt.

import { MSG } from '../lib/messages.js';
import { CONFIG } from '../lib/config.js';
import { debug } from '../lib/debug.js';

const log = debug('Offscreen');

let tabAudioContext = null;
let playbackAudioEl = null; // <audio> element for reliable tab audio playback
let playbackStream = null; // Cloned stream for playback (separate from processing stream)
let playbackHealthTimer = null;
let tabMediaStream = null;
let tabProcessorNode = null;
let audioHealthTimer = null;

// ─── Base64 Encoding ─────────────────────────────────────────────────────────
// ArrayBuffer cannot survive chrome.runtime.sendMessage JSON serialization.
// We encode PCM16 audio as base64 string for safe transport to service worker.

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ─── Tab Audio Capture ──────────────────────────────────────────────────────

async function startTabAudioCapture(streamId) {
  try {
    log.info('Starting tab audio capture with streamId:', streamId?.substring(0, 20) + '...');
    // Get tab audio stream using the streamId from chrome.tabCapture
    tabMediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });

    // ── Playback: restore audio the user hears ──
    // chrome.tabCapture mutes the tab's native audio. We use an <audio> element
    // (not AudioContext.destination) because it uses the browser's native playback
    // pipeline which correctly routes to the system output device.
    //
    // IMPORTANT: We clone the stream for playback so that the <audio> element and
    // the processing AudioContext each have independent access. Sharing a single
    // MediaStream between an <audio> element and an AudioContext can cause Chrome
    // to silence the <audio> element (the user hears nothing from the client).
    playbackStream = tabMediaStream.clone();
    playbackAudioEl = document.createElement('audio');
    playbackAudioEl.srcObject = playbackStream;
    playbackAudioEl.volume = 1.0;
    await playbackAudioEl.play().catch((e) => {
      console.warn('[NovumAI Offscreen] Audio playback autoplay failed, retrying:', e);
      return new Promise((r) => setTimeout(r, 100)).then(() => playbackAudioEl.play());
    });
    console.log('[NovumAI Offscreen] Tab audio playback restored via <audio> element (cloned stream)');

    // Health monitor: if playback pauses/suspends mid-session, recover it
    playbackHealthTimer = setInterval(() => {
      if (playbackAudioEl && playbackAudioEl.paused && playbackStream?.active) {
        console.warn('[NovumAI Offscreen] Playback paused unexpectedly, resuming...');
        playbackAudioEl.play().catch(() => {});
      }
    }, 2000);

    // ── Processing: 16kHz PCM for AssemblyAI transcription ──
    tabAudioContext = new AudioContext({ sampleRate: CONFIG.SAMPLE_RATE });
    if (tabAudioContext.state === 'suspended') {
      await tabAudioContext.resume();
    }

    // AudioWorklet runs PCM16 conversion on a dedicated audio thread — avoids the
    // main-thread jank of the deprecated ScriptProcessorNode.
    await tabAudioContext.audioWorklet.addModule('./pcm-processor-tab.js');
    tabProcessorNode = new AudioWorkletNode(tabAudioContext, 'pcm-processor-tab');
    tabProcessorNode.port.onmessage = (event) => {
      const buf = event.data?.audioData;
      if (!buf) return;
      const base64Audio = arrayBufferToBase64(buf);
      chrome.runtime.sendMessage({
        type: MSG.TAB_AUDIO_CHUNK,
        target: 'background',
        data: { audioData: base64Audio },
      }).catch(() => {});
    };

    const processingSource = tabAudioContext.createMediaStreamSource(tabMediaStream);
    processingSource.connect(tabProcessorNode);
    // AudioWorkletNode stays active purely by being in the render graph — it does
    // not need a connection to the destination. The <audio> element above handles
    // user-audible playback via an independent cloned stream.

    console.log('[NovumAI Offscreen] Tab audio capture started (AudioWorklet)');
  } catch (e) {
    console.error('[NovumAI Offscreen] Tab audio capture failed:', e);
    throw e;
  }
}

// ─── Audio Health Reporting ──────────────────────────────────────────────────

function startAudioHealthReporting() {
  if (audioHealthTimer) clearInterval(audioHealthTimer);
  audioHealthTimer = setInterval(() => {
    const tabActive = tabMediaStream?.active ?? false;
    const tabTrackLive = tabMediaStream?.getAudioTracks()[0]?.readyState === 'live';

    chrome.runtime.sendMessage({
      type: MSG.AUDIO_HEALTH,
      target: 'background',
      data: {
        tabAudio: tabActive && tabTrackLive,
        tabContextState: tabAudioContext?.state || 'closed',
        // micAudio is reported by content script, not offscreen
      },
    }).catch(() => {});
  }, 3000);
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

function stopAllCapture() {
  // Tab audio
  if (tabProcessorNode) {
    try { tabProcessorNode.port.onmessage = null; } catch {}
    tabProcessorNode.disconnect();
    tabProcessorNode = null;
  }
  if (tabMediaStream) {
    tabMediaStream.getTracks().forEach((t) => t.stop());
    tabMediaStream = null;
  }
  if (tabAudioContext) {
    tabAudioContext.close().catch(() => {});
    tabAudioContext = null;
  }
  if (playbackHealthTimer) {
    clearInterval(playbackHealthTimer);
    playbackHealthTimer = null;
  }
  if (playbackAudioEl) {
    playbackAudioEl.pause();
    playbackAudioEl.srcObject = null;
    playbackAudioEl = null;
  }
  if (playbackStream) {
    playbackStream.getTracks().forEach((t) => t.stop());
    playbackStream = null;
  }

  if (audioHealthTimer) {
    clearInterval(audioHealthTimer);
    audioHealthTimer = null;
  }

  console.log('[NovumAI Offscreen] All capture stopped');
}

// ─── Message Listener ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message.target && message.target !== 'offscreen') return false;

  if (message.type === MSG.START_AUDIO_CAPTURE) {
    const { streamId } = message.data;

    (async () => {
      try {
        await startTabAudioCapture(streamId);
        startAudioHealthReporting();
        sendResponse({ success: true });
      } catch (e) {
        // Clean up any partially started resources to release the tab stream
        // This prevents "Cannot capture a tab with an active stream" on retry
        stopAllCapture();
        sendResponse({ success: false, error: e.message });
      }
    })();

    return true;
  }

  if (message.type === MSG.STOP_AUDIO_CAPTURE) {
    stopAllCapture();
    sendResponse({ success: true });
    return true;
  }

  return false;
});

// Notify background that offscreen is ready
chrome.runtime.sendMessage({
  type: MSG.OFFSCREEN_READY,
  target: 'background',
});
