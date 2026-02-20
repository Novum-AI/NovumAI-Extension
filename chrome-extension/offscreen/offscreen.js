// NovumAI Offscreen Document
// Handles audio capture and PCM16 conversion
// Runs in an offscreen document because service workers can't use AudioContext

import { MSG } from '../lib/messages.js';
import { CONFIG } from '../lib/config.js';

let tabAudioContext = null;
let micAudioContext = null;
let playbackAudioEl = null; // <audio> element for reliable tab audio playback
let playbackStream = null; // Cloned stream for playback (separate from processing stream)
let playbackHealthTimer = null;
let tabMediaStream = null;
let micMediaStream = null;
let tabProcessorNode = null;
let micProcessorNode = null;

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

function createPcmScriptProcessor(audioCtx, streamType, onChunk) {
  // ScriptProcessorNode avoids AudioWorklet module loading/CSP issues in offscreen docs.
  const processor = audioCtx.createScriptProcessor(4096, 1, 1);
  let sampleBuffer = [];
  let sampleCount = 0;
  const targetSamples = CONFIG.BUFFER_TARGET_SAMPLES;

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer?.getChannelData(0);
    if (!input || input.length === 0) return;

    for (let i = 0; i < input.length; i++) {
      sampleBuffer.push(input[i]);
    }
    sampleCount += input.length;

    if (sampleCount >= targetSamples) {
      const int16 = new Int16Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        const s = Math.max(-1, Math.min(1, sampleBuffer[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      onChunk(int16.buffer, streamType);
      sampleBuffer = [];
      sampleCount = 0;
    }
  };

  return processor;
}

// ─── Tab Audio Capture ──────────────────────────────────────────────────────

async function startTabAudioCapture(streamId) {
  try {
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

    const processingSource = tabAudioContext.createMediaStreamSource(tabMediaStream);
    tabProcessorNode = createPcmScriptProcessor(tabAudioContext, 'tab', (audioData) => {
      const base64Audio = arrayBufferToBase64(audioData);
      chrome.runtime.sendMessage({
        type: MSG.TAB_AUDIO_CHUNK,
        target: 'background',
        data: { audioData: base64Audio },
      }).catch(() => {});
    });
    processingSource.connect(tabProcessorNode);
    // Keep processor in the render graph so onaudioprocess continues firing.
    tabProcessorNode.connect(tabAudioContext.destination);

    console.log('[NovumAI Offscreen] Tab audio capture started');
  } catch (e) {
    console.error('[NovumAI Offscreen] Tab audio capture failed:', e);
    throw e;
  }
}

// ─── Microphone Capture ─────────────────────────────────────────────────────

async function startMicCapture() {
  try {
    micMediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: CONFIG.SAMPLE_RATE,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    micAudioContext = new AudioContext({ sampleRate: CONFIG.SAMPLE_RATE });
    if (micAudioContext.state === 'suspended') {
      await micAudioContext.resume();
    }

    const source = micAudioContext.createMediaStreamSource(micMediaStream);
    micProcessorNode = createPcmScriptProcessor(micAudioContext, 'mic', (audioData) => {
      const base64Audio = arrayBufferToBase64(audioData);
      chrome.runtime.sendMessage({
        type: MSG.MIC_AUDIO_CHUNK,
        target: 'background',
        data: { audioData: base64Audio },
      }).catch(() => {});
    });
    source.connect(micProcessorNode);
    micProcessorNode.connect(micAudioContext.destination);

    console.log('[NovumAI Offscreen] Mic capture started');
  } catch (e) {
    console.error('[NovumAI Offscreen] Mic capture failed:', e);
    // Mic failure is non-fatal - tab audio still works
  }
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

function stopAllCapture() {
  // Tab audio
  if (tabProcessorNode) {
    tabProcessorNode.onaudioprocess = null;
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

  // Mic audio
  if (micProcessorNode) {
    micProcessorNode.onaudioprocess = null;
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

  console.log('[NovumAI Offscreen] All capture stopped');
}

// ─── Message Listener ───────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target && message.target !== 'offscreen') return false;

  if (message.type === MSG.START_AUDIO_CAPTURE) {
    const { streamId } = message.data;

    (async () => {
      try {
        await startTabAudioCapture(streamId);
        await startMicCapture();
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
