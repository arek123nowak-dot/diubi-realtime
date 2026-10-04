const TARGET_SAMPLE_RATE = 24000; // must match server.js

let ws = null;
let audioContext = null;
let processorNode = null;
let sourceNode = null;
let captureStream = null;

chrome.runtime.onMessage.addListener((message) => {
  if (message.target !== "offscreen") return;

  if (message.type === "start-capture") {
    startCapture(message.streamId, message.targetLang, message.wsUrl);
  } else if (message.type === "stop-capture") {
    stopCapture();
  }
});

async function startCapture(streamId, targetLang, wsUrl) {
  stopCapture(); // clean slate if something was already running

  captureStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });

  audioContext = new AudioContext();
  sourceNode = audioContext.createMediaStreamSource(captureStream);

  // tabCapture gives this document exclusive access to the tab's audio, so
  // without this the tab goes silent the moment capture starts — route it
  // straight back out to speakers alongside the downsampling tap below.
  sourceNode.connect(audioContext.destination);

  const inputChannels = sourceNode.channelCount || 1;
  processorNode = audioContext.createScriptProcessor(4096, inputChannels, 1);
  const ratio = audioContext.sampleRate / TARGET_SAMPLE_RATE;

  ws = new WebSocket(`${wsUrl}?target=${encodeURIComponent(targetLang)}`);

  ws.onopen = () => relay({ type: "status", message: "Polaczono, uruchamiam przechwytywanie..." });
  ws.onmessage = (event) => relay(JSON.parse(event.data));
  ws.onerror = () => relay({ type: "error", message: "Blad polaczenia z serwerem DIUBI." });
  ws.onclose = () => relay({ type: "status", message: "Polaczenie zamkniete." });

  processorNode.onaudioprocess = (event) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const input = event.inputBuffer;
    const channelCount = input.numberOfChannels;
    const length = input.length;

    const mono = new Float32Array(length);
    for (let ch = 0; ch < channelCount; ch++) {
      const data = input.getChannelData(ch);
      for (let i = 0; i < length; i++) mono[i] += data[i] / channelCount;
    }

    const outLength = Math.floor(mono.length / ratio);
    const pcm16 = new Int16Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const sample = mono[Math.floor(i * ratio)] || 0;
      const clamped = Math.max(-1, Math.min(1, sample));
      pcm16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }

    ws.send(JSON.stringify({ type: "audio_chunk", audio: arrayBufferToBase64(pcm16.buffer) }));
  };

  sourceNode.connect(processorNode);
  processorNode.connect(audioContext.destination);
}

function stopCapture() {
  if (ws) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" }));
    ws.close();
    ws = null;
  }
  if (processorNode) {
    processorNode.disconnect();
    processorNode = null;
  }
  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  if (captureStream) {
    captureStream.getTracks().forEach((t) => t.stop());
    captureStream = null;
  }
}

function relay(payload) {
  chrome.runtime.sendMessage({ target: "background", type: "relay", payload });
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
