const state = {
  abortController: null,
  callId: null,
  config: null,
  dataChannel: null,
  localStream: null,
  pc: null,
  remoteStream: null,
  runId: 0,
  micEnabled: true,
};

const dom = {
  callIdText: document.getElementById('callIdText'),
  configForm: document.getElementById('configForm'),
  connectButton: document.getElementById('connectButton'),
  connectionChip: document.getElementById('connectionChip'),
  eventLog: document.getElementById('eventLog'),
  helperText: document.getElementById('helperText'),
  instructionsInput: document.getElementById('instructionsInput'),
  micText: document.getElementById('micText'),
  modelInput: document.getElementById('modelInput'),
  muteButton: document.getElementById('muteButton'),
  remoteAudio: document.getElementById('remoteAudio'),
  resetButton: document.getElementById('resetButton'),
  statusText: document.getElementById('statusText'),
  transcriptFeed: document.getElementById('transcriptFeed'),
  voiceSelect: document.getElementById('voiceSelect'),
};

function setStatus(text, tone = 'idle') {
  dom.statusText.textContent = text;
  dom.connectionChip.textContent = text;
  dom.connectionChip.classList.toggle('is-live', tone === 'live');
  dom.connectionChip.classList.toggle('is-error', tone === 'error');
}

function setCallId(callId) {
  dom.callIdText.textContent = callId || '-';
}

function setMicText() {
  dom.micText.textContent = state.localStream && state.micEnabled ? 'On' : 'Off';
  dom.muteButton.textContent = state.micEnabled ? 'Mic on' : 'Mic muted';
  dom.muteButton.disabled = !state.localStream;
}

function logEvent(type, detail) {
  const item = document.createElement('div');
  item.className = 'log-item';

  const title = document.createElement('strong');
  title.textContent = type;

  const body = document.createElement('span');
  body.textContent = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2);

  item.append(title, body);
  dom.eventLog.prepend(item);

  while (dom.eventLog.children.length > 24) {
    dom.eventLog.removeChild(dom.eventLog.lastElementChild);
  }
}

function inferRole(eventType, payload) {
  if (eventType.includes('input_audio_transcription')) {
    return 'user';
  }

  if (eventType.startsWith('response.')) {
    return 'assistant';
  }

  if (payload?.item?.role === 'user' || payload?.role === 'user') {
    return 'user';
  }

  return 'assistant';
}

function extractDelta(payload) {
  const candidates = [
    payload?.delta,
    payload?.text?.delta,
    payload?.text,
    payload?.transcript?.delta,
    payload?.transcript,
    payload?.output_text?.delta,
    payload?.output_audio_transcript?.delta,
    payload?.item?.content?.[0]?.text,
    payload?.item?.text,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }

  return '';
}

function extractKey(payload) {
  return (
    payload?.response_id ||
    payload?.item_id ||
    payload?.item?.id ||
    payload?.id ||
    payload?.type ||
    'event'
  );
}

function upsertTranscript(role, key, text, suffix = '') {
  let bubble = dom.transcriptFeed.querySelector(`[data-key="${CSS.escape(key)}"]`);

  if (!bubble) {
    bubble = document.createElement('article');
    bubble.className = `bubble bubble-${role}`;
    bubble.dataset.key = key;

    const meta = document.createElement('div');
    meta.className = 'bubble-meta';

    const label = document.createElement('span');
    label.textContent = role === 'user' ? 'You' : 'Assistant';

    const mark = document.createElement('span');
    mark.textContent = role === 'user' ? 'Audio transcript' : 'Response';

    const body = document.createElement('div');
    body.className = 'bubble-text';

    meta.append(label, mark);
    bubble.append(meta, body);
    dom.transcriptFeed.prepend(bubble);
  }

  const textNode = bubble.querySelector('.bubble-text');
  textNode.textContent = `${textNode.textContent || ''}${text}${suffix}`;

  while (dom.transcriptFeed.children.length > 20) {
    dom.transcriptFeed.removeChild(dom.transcriptFeed.lastElementChild);
  }
}

function handleEvent(payload) {
  const type = payload?.type || 'message';
  logEvent(type, payload);

  if (type === 'session.created' || type === 'session.updated') {
    setStatus('Live', 'live');
  }

  const text = extractDelta(payload);
  if (text) {
    const role = inferRole(type, payload);
    const key = extractKey(payload);
    upsertTranscript(role, key, text);
  }

  if (type === 'conversation.item.input_audio_transcription.completed' && payload?.transcript) {
    upsertTranscript('user', extractKey(payload), payload.transcript);
  }

  if (type === 'response.done' && payload?.response?.output) {
    const responseText = payload.response.output;
    if (typeof responseText === 'string' && responseText.trim()) {
      upsertTranscript('assistant', extractKey(payload), responseText, '\n');
    }
  }
}

function sendSessionUpdate() {
  if (!state.dataChannel || state.dataChannel.readyState !== 'open') {
    return;
  }

  const payload = {
    type: 'session.update',
    session: {
      instructions: dom.instructionsInput.value.trim(),
      audio: {
        output: {
          voice: dom.voiceSelect.value,
        },
      },
    },
  };

  state.dataChannel.send(JSON.stringify(payload));
  logEvent('session.update', payload);
}

function waitForIceGatheringComplete(pc, signal) {
  if (pc.iceGatheringState === 'complete') {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, 2500);

    const cleanup = () => {
      clearTimeout(timeout);
      pc.removeEventListener('icegatheringstatechange', onStateChange);
      signal?.removeEventListener('abort', onAbort);
    };

    const onStateChange = () => {
      if (pc.iceGatheringState === 'complete') {
        cleanup();
        resolve();
      }
    };

    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    pc.addEventListener('icegatheringstatechange', onStateChange);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function loadConfig() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) {
      throw new Error(`Config request failed with ${response.status}`);
    }

    const config = await response.json();
    state.config = config;
    dom.modelInput.value = config.defaults.model;
    dom.voiceSelect.value = config.defaults.voice;
    dom.instructionsInput.value = config.defaults.instructions;
    dom.helperText.textContent = config.configured
      ? 'The server is configured and ready for a Realtime session.'
      : 'Set OPENAI_API_KEY on the server before trying to connect.';
  } catch (error) {
    dom.helperText.textContent = `Unable to load server config: ${error.message}`;
  }
}

async function startSession() {
  if (state.pc) {
    return;
  }

  state.runId += 1;
  const runId = state.runId;
  state.abortController = new AbortController();
  setStatus('Connecting', 'idle');
  dom.connectButton.disabled = true;
  dom.helperText.textContent = 'Requesting microphone permission and creating the WebRTC session...';

  try {
    const localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    if (runId !== state.runId) {
      localStream.getTracks().forEach((track) => track.stop());
      return;
    }

    state.localStream = localStream;
    state.micEnabled = true;
    setMicText();

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    state.pc = pc;
    state.remoteStream = new MediaStream();

    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

    pc.ontrack = (event) => {
      if (event.streams[0]) {
        dom.remoteAudio.srcObject = event.streams[0];
      } else {
        state.remoteStream.addTrack(event.track);
        dom.remoteAudio.srcObject = state.remoteStream;
      }
      dom.remoteAudio.play().catch(() => {});
      setStatus('Live', 'live');
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
        if (state.pc === pc) {
          stopSession(`Connection ${pc.connectionState}.`);
        }
      } else if (pc.connectionState === 'connected') {
        setStatus('Live', 'live');
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        logEvent('iceconnectionstatechange', { state: pc.iceConnectionState });
      }
    };

    const dataChannel = pc.createDataChannel('oai-events');
    state.dataChannel = dataChannel;

    dataChannel.onopen = () => {
      logEvent('datachannel.open', { label: dataChannel.label });
      sendSessionUpdate();
    };

    dataChannel.onmessage = (event) => {
      let payload = event.data;
      try {
        payload = JSON.parse(payload);
      } catch (error) {
        payload = { type: 'message', text: String(event.data) };
      }

      handleEvent(payload);
    };

    dataChannel.onerror = (error) => {
      logEvent('datachannel.error', {
        message: error?.message || 'Unknown data channel error',
      });
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc, state.abortController.signal);

    const payload = {
      sdp: pc.localDescription?.sdp || offer.sdp,
      model: dom.modelInput.value.trim(),
      voice: dom.voiceSelect.value,
      instructions: dom.instructionsInput.value.trim(),
    };

    const response = await fetch('/api/realtime/call', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: state.abortController.signal,
    });

    const body = await response.json().catch(async () => ({
      error: await response.text(),
    }));

    if (runId !== state.runId) {
      return;
    }

    if (!response.ok) {
      throw new Error(body.detail || body.error || `OpenAI request failed with ${response.status}`);
    }

    state.callId = body.callId || body.location || null;
    setCallId(state.callId);

    await pc.setRemoteDescription({
      type: 'answer',
      sdp: body.sdp,
    });

    setStatus('Live', 'live');
    dom.helperText.textContent = 'Speak naturally. The assistant should respond with streamed audio and transcript events.';
  } catch (error) {
    if (error.name === 'AbortError') {
      return;
    }

    stopSession(error.message || 'Unable to connect.');
    setStatus('Error', 'error');
    dom.helperText.textContent = error.message || 'Connection failed.';
  } finally {
    dom.connectButton.disabled = false;
    dom.connectButton.textContent = state.pc ? 'Disconnect' : 'Connect';
    setMicText();
  }
}

function stopSession(reason) {
  state.runId += 1;
  state.abortController?.abort();
  state.abortController = null;

  if (state.dataChannel) {
    try {
      state.dataChannel.close();
    } catch (error) {
      // Ignore close errors.
    }
  }

  if (state.pc) {
    try {
      state.pc.getSenders().forEach((sender) => sender.track?.stop());
      state.pc.close();
    } catch (error) {
      // Ignore close errors.
    }
  }

  if (state.localStream) {
    state.localStream.getTracks().forEach((track) => track.stop());
  }

  state.pc = null;
  state.dataChannel = null;
  state.localStream = null;
  state.remoteStream = null;
  state.callId = null;
  state.micEnabled = false;
  dom.remoteAudio.srcObject = null;
  setCallId(null);
  setMicText();
  setStatus(reason ? 'Idle' : 'Idle', 'idle');
  dom.connectButton.textContent = 'Connect';
}

function toggleMic() {
  if (!state.localStream) {
    return;
  }

  state.micEnabled = !state.micEnabled;
  state.localStream.getAudioTracks().forEach((track) => {
    track.enabled = state.micEnabled;
  });

  setMicText();
  logEvent('mic.toggle', { enabled: state.micEnabled });
}

function resetDemo() {
  stopSession();
  dom.transcriptFeed.innerHTML = '';
  dom.eventLog.innerHTML = '';
  dom.helperText.textContent = state.config?.configured
    ? 'The server is configured and ready for a Realtime session.'
    : 'Set OPENAI_API_KEY on the server before trying to connect.';
  setStatus('Idle', 'idle');
  setCallId(null);
}

dom.connectButton.addEventListener('click', async () => {
  if (state.pc) {
    stopSession();
    return;
  }

  await startSession();
});

dom.muteButton.addEventListener('click', () => {
  toggleMic();
});

dom.resetButton.addEventListener('click', () => {
  resetDemo();
});

dom.configForm.addEventListener('submit', (event) => {
  event.preventDefault();
});

window.addEventListener('beforeunload', () => {
  stopSession();
});

loadConfig().finally(() => {
  setMicText();
});
