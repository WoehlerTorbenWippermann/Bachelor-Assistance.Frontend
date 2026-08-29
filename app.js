// ── Config ─────────────────────────────────────────────────────────────────
const WS_URL = `ws://${location.hostname}:40002`;

// ── State ──────────────────────────────────────────────────────────────────
let ws          = null;
let queue       = [];
let current     = null;
let boxes       = [];
let drawMode    = 'draw';
let isDragging  = false;
let dragStart   = null;
let pendingBox  = null;
let scaleX      = 1;
let scaleY      = 1;

// ── DOM refs ───────────────────────────────────────────────────────────────
const $waitingScreen   = document.getElementById('waiting-screen');
const $workspace       = document.getElementById('workspace');
const $statusDot       = document.getElementById('status-dot');
const $statusText      = document.getElementById('status-text');
const $infoSession     = document.getElementById('info-session');
const $infoQuestion    = document.getElementById('info-question');
const $infoQueue       = document.getElementById('info-queue');
const $queueBadge      = document.getElementById('queue-badge');
const $baseImg         = document.getElementById('base-img');
const $drawCanvas      = document.getElementById('draw-canvas');
const $overlayCanvas   = document.getElementById('overlay-canvas');
const $boxesList       = document.getElementById('boxes-list');
const $boxesEmpty      = document.getElementById('boxes-empty');
const $labelModal      = document.getElementById('label-modal-overlay');
const $labelInput      = document.getElementById('label-input');
const $canvasContainer = document.getElementById('canvas-container');

// Audio recorder
const $btnRecord       = document.getElementById('btn-record');
const $btnStopRecord   = document.getElementById('btn-stop-record');
const $recIndicator    = document.getElementById('rec-indicator');
const $recTimer        = document.getElementById('rec-timer');
const $audioPlayback   = document.getElementById('audio-playback');
const $audioStatus     = document.getElementById('audio-status');

const ctxDraw    = $drawCanvas.getContext('2d');
const ctxOverlay = $overlayCanvas.getContext('2d');

// ── WebSocket ──────────────────────────────────────────────────────────────
function connect() {
  setStatus('connecting', 'Verbinde…');
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    setStatus('connected', 'Verbunden');
    ws.send(JSON.stringify({ type: 'register', role: 'browser' }));
  };

  ws.onclose = () => {
    setStatus('', 'Getrennt — verbinde erneut…');
    setTimeout(connect, 3000);
  };

  ws.onerror = () => {
    setStatus('', 'Verbindungsfehler');
  };

  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      if (msg.type === 'request' && msg.assistanceMode === 'HumanAssistance') {
        enqueue(msg);
      }
    } catch (e) {
      console.warn('Parse error', e);
    }
  };
}

function setStatus(cls, text) {
  $statusDot.className    = cls;
  $statusText.textContent = text;
}

// ── Request queue ──────────────────────────────────────────────────────────
function enqueue(request) {
  queue.push(request);
  updateQueueBadge();
  if (!current) showNext();
}

function showNext() {
  if (queue.length === 0) {
    current = null;
    $workspace.classList.remove('active');
    $waitingScreen.style.display = '';
    return;
  }

  current = queue.shift();
  updateQueueBadge();
  clearBoxes();
  resetAudioRecorder();

  $infoSession.textContent  = current.sessionId ?? '–';
  $infoQuestion.textContent = current.question  ?? '–';

  $waitingScreen.style.display = 'none';
  $workspace.classList.add('active');

  loadImage(current.image ? 'data:image/jpeg;base64,' + current.image : null);
}

function updateQueueBadge() {
  $infoQueue.textContent  = queue.length;
  $queueBadge.textContent = queue.length > 0 ? queue.length : '';
}

// ── Image loading ──────────────────────────────────────────────────────────
function loadImage(src) {
  if (!src) {
    $baseImg.removeAttribute('src');
    resizeCanvases(400, 300);
    return;
  }
  $baseImg.onload = () => resizeCanvases($baseImg.naturalWidth, $baseImg.naturalHeight);
  $baseImg.src = src;
}

function resizeCanvases(natW, natH) {
  const wrap = document.getElementById('canvas-wrap');
  const maxW = wrap.clientWidth  - 32;
  const maxH = wrap.clientHeight - 32;

  let dispW = natW, dispH = natH;
  if (dispW > maxW) { dispH = Math.round(dispH * maxW / dispW); dispW = maxW; }
  if (dispH > maxH) { dispW = Math.round(dispW * maxH / dispH); dispH = maxH; }

  $baseImg.style.width  = dispW + 'px';
  $baseImg.style.height = dispH + 'px';

  [$drawCanvas, $overlayCanvas].forEach(c => {
    c.width        = dispW;
    c.height       = dispH;
    c.style.width  = dispW + 'px';
    c.style.height = dispH + 'px';
  });

  scaleX = natW / dispW;
  scaleY = natH / dispH;

  redrawBoxes();
}

// ── Color swatches ─────────────────────────────────────────────────────────
function pickColor(btn) {
  document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('box-color').value = btn.dataset.color;
}

function pickColorFromInput(input) {
  document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
  input.value = input.value; // already set
}

// ── Drawing mode ───────────────────────────────────────────────────────────
function setMode(mode) {
  drawMode = mode;
  $canvasContainer.className = mode === 'view' ? 'mode-view' : '';
  document.getElementById('btn-draw').classList.toggle('active', mode === 'draw');
  document.getElementById('btn-view').classList.toggle('active', mode === 'view');
}

function getPos(evt) {
  const rect = $overlayCanvas.getBoundingClientRect();
  return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
}

$overlayCanvas.addEventListener('mousedown', e => {
  if (drawMode !== 'draw') return;
  isDragging = true;
  dragStart  = getPos(e);
});

$overlayCanvas.addEventListener('mousemove', e => {
  if (!isDragging) return;
  const pos   = getPos(e);
  const color = document.getElementById('box-color').value;
  ctxDraw.clearRect(0, 0, $drawCanvas.width, $drawCanvas.height);
  ctxDraw.strokeStyle = color;
  ctxDraw.lineWidth   = 2;
  ctxDraw.setLineDash([5, 3]);
  ctxDraw.strokeRect(dragStart.x, dragStart.y, pos.x - dragStart.x, pos.y - dragStart.y);
});

$overlayCanvas.addEventListener('mouseup', e => {
  if (!isDragging) return;
  isDragging = false;
  ctxDraw.clearRect(0, 0, $drawCanvas.width, $drawCanvas.height);

  const pos = getPos(e);
  const w   = pos.x - dragStart.x;
  const h   = pos.y - dragStart.y;
  if (Math.abs(w) < 8 || Math.abs(h) < 8) return;

  pendingBox = {
    x1:    Math.round(Math.min(dragStart.x, pos.x)),
    y1:    Math.round(Math.min(dragStart.y, pos.y)),
    x2:    Math.round(Math.max(dragStart.x, pos.x)),
    y2:    Math.round(Math.max(dragStart.y, pos.y)),
    color: document.getElementById('box-color').value
  };
  openLabelModal();
});

$overlayCanvas.addEventListener('mouseleave', () => {
  if (isDragging) {
    isDragging = false;
    ctxDraw.clearRect(0, 0, $drawCanvas.width, $drawCanvas.height);
  }
});

// ── Label modal ────────────────────────────────────────────────────────────
function openLabelModal() {
  $labelInput.value = '';
  $labelModal.classList.add('open');
  setTimeout(() => $labelInput.focus(), 50);
}

$labelInput.addEventListener('keydown', e => {
  if (e.key === 'Enter')  confirmBox();
  if (e.key === 'Escape') cancelBox();
});

function confirmBox() {
  pendingBox.label = $labelInput.value.trim() || 'Unbekannt';
  boxes.push({ ...pendingBox });
  pendingBox = null;
  $labelModal.classList.remove('open');
  redrawBoxes();
  updateBoxList();
  cycleToNextColor();
}

function cycleToNextColor() {
  const swatches = Array.from(document.querySelectorAll('.swatch'));
  const active   = swatches.findIndex(s => s.classList.contains('active'));
  const next     = swatches[(active + 1) % swatches.length];
  pickColor(next);
}

function cancelBox() {
  pendingBox = null;
  $labelModal.classList.remove('open');
}

// ── Box management ─────────────────────────────────────────────────────────
function redrawBoxes() {
  ctxOverlay.clearRect(0, 0, $overlayCanvas.width, $overlayCanvas.height);
  boxes.forEach(b => {
    ctxOverlay.strokeStyle = b.color;
    ctxOverlay.lineWidth   = 2;
    ctxOverlay.setLineDash([]);
    ctxOverlay.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);

    ctxOverlay.font = 'bold 12px Segoe UI, sans-serif';
    const tw = ctxOverlay.measureText(b.label).width;
    ctxOverlay.fillStyle = b.color;
    ctxOverlay.fillRect(b.x1, b.y1 - 18, tw + 8, 18);
    ctxOverlay.fillStyle = '#fff';
    ctxOverlay.fillText(b.label, b.x1 + 4, b.y1 - 4);
  });
}

function updateBoxList() {
  $boxesEmpty.style.display = boxes.length === 0 ? '' : 'none';
  Array.from($boxesList.querySelectorAll('.box-item')).forEach(el => el.remove());

  boxes.forEach((b, i) => {
    const item = document.createElement('div');
    item.className = 'box-item';
    item.innerHTML = `
      <div class="box-swatch" style="background:${b.color}"></div>
      <span class="box-label" title="${b.label}">${b.label}</span>
      <span class="box-coords">[${b.x1},${b.y1},${b.x2},${b.y2}]</span>
      <button class="del" onclick="removeBox(${i})">✕</button>
    `;
    $boxesList.appendChild(item);
  });
}

function removeBox(i) {
  boxes.splice(i, 1);
  redrawBoxes();
  updateBoxList();
}

function undoLastBox() {
  if (boxes.length === 0) return;
  boxes.pop();
  redrawBoxes();
  updateBoxList();
}

function clearBoxes() {
  boxes = [];
  redrawBoxes();
  updateBoxList();
}

// ── Send response ──────────────────────────────────────────────────────────
async function sendResponse() {
  if (!current || !ws || ws.readyState !== WebSocket.OPEN) return;

  // Automatically stop an ongoing recording
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    await new Promise(resolve => {
      mediaRecorder.addEventListener('stop', resolve, { once: true });
      stopRecording();
    });
    // briefly wait until the upload is complete
    await new Promise(resolve => setTimeout(resolve, 800));
  }

  const scaledBoxes = boxes.map(b => ({
    label:  b.label,
    box_2d: [
      Math.round(b.x1 * scaleX),
      Math.round(b.y1 * scaleY),
      Math.round(b.x2 * scaleX),
      Math.round(b.y2 * scaleY)
    ]
  }));

  // Export and upload the canvas image (if an image is present)
  let imageUrl = null;
  if ($baseImg.src && $baseImg.naturalWidth > 0) {
    try {
      imageUrl = await exportAndUploadCanvas();
    } catch (e) {
      console.warn('Image upload failed:', e);
    }
  }

  ws.send(JSON.stringify({
    type:       'response',
    session_id: current.sessionId,
    answer:     recordedTranscript,
    image_url:  imageUrl         || null,
    audio_url:  recordedAudioUrl || null,
    boxes:      scaledBoxes
  }));

  showToast('Antwort gesendet ✓', 'success');
  showNext();
}

// Renders the original image + bounding boxes onto an offscreen canvas,
// uploads the resulting JPEG to the local server and returns the URL.
async function exportAndUploadCanvas() {
  const offscreen = document.createElement('canvas');
  offscreen.width  = $baseImg.naturalWidth;
  offscreen.height = $baseImg.naturalHeight;
  const ctx = offscreen.getContext('2d');

  // Draw the original image
  ctx.drawImage($baseImg, 0, 0, offscreen.width, offscreen.height);

  // Draw bounding boxes at native resolution
  boxes.forEach(b => {
    const x1 = Math.round(b.x1 * scaleX);
    const y1 = Math.round(b.y1 * scaleY);
    const x2 = Math.round(b.x2 * scaleX);
    const y2 = Math.round(b.y2 * scaleY);

    ctx.strokeStyle = b.color;
    ctx.lineWidth   = 9;
    ctx.setLineDash([]);
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);

    ctx.font = 'bold 20px Segoe UI, sans-serif';
    const tw = ctx.measureText(b.label).width;
    ctx.fillStyle = b.color;
    ctx.fillRect(x1, y1 - 26, tw + 10, 26);
    ctx.fillStyle = '#fff';
    ctx.fillText(b.label, x1 + 5, y1 - 5);
  });

  // Canvas → Blob → FormData → Upload
  const blob = await new Promise(resolve => offscreen.toBlob(resolve, 'image/jpeg', 0.92));
  const form = new FormData();
  form.append('image', blob, 'annotated.jpg');

  const res  = await fetch('/upload/image', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Upload HTTP ${res.status}`);
  const json = await res.json();
  return json.image_url;
}

function skipRequest() {
  showNext();
}

// ── Audio Recording ────────────────────────────────────────────────────────
let mediaRecorder    = null;
let audioChunks      = [];
let recordedAudioUrl = null;   // uploaded URL
let recordedTranscript = '';   // STT result
let recTimerInterval = null;
let recSeconds       = 0;

// ── Speech Recognition ─────────────────────────────────────────────────────
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

function startSpeechRecognition() {
  if (!SpeechRecognition) return;
  recognition = new SpeechRecognition();
  recognition.lang = 'de-DE';
  recognition.continuous = true;
  recognition.interimResults = true;

  let finalTranscript = '';

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalTranscript += t + ' ';
      else interim = t;
    }
    recordedTranscript = (finalTranscript + interim).trim();
    updateTranscriptDisplay(recordedTranscript);
  };

  recognition.onerror = (e) => {
    if (e.error !== 'no-speech') console.warn('STT error:', e.error);
  };

  recognition.start();
}

function stopSpeechRecognition() {
  if (recognition) {
    recognition.stop();
    recognition = null;
  }
}

function updateTranscriptDisplay(text) {
  const box = document.getElementById('transcript-box');
  const display = document.getElementById('transcript-display');
  if (!text) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  display.textContent = text;
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks  = [];
    recordedAudioUrl = null;
    $audioPlayback.style.display = 'none';
    $audioPlayback.src = '';
    setAudioStatus('');

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    mediaRecorder = new MediaRecorder(stream, { mimeType });
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      onRecordingStopped(mimeType);
    };

    mediaRecorder.start();
    startSpeechRecognition();

    // UI
    $btnRecord.disabled   = true;
    $btnRecord.classList.add('recording');
    $btnStopRecord.disabled = false;
    $recIndicator.classList.add('active');
    recSeconds = 0;
    $recTimer.textContent = '00:00';
    recTimerInterval = setInterval(() => {
      recSeconds++;
      const m = String(Math.floor(recSeconds / 60)).padStart(2, '0');
      const s = String(recSeconds % 60).padStart(2, '0');
      $recTimer.textContent = `${m}:${s}`;
    }, 1000);

    setAudioStatus('Aufnahme läuft…');
  } catch (err) {
    setAudioStatus(`Mikrofon-Fehler: ${err.message}`);
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  stopSpeechRecognition();
  clearInterval(recTimerInterval);
  $btnRecord.disabled   = false;
  $btnRecord.classList.remove('recording');
  $btnStopRecord.disabled = true;
  $recIndicator.classList.remove('active');
}

async function onRecordingStopped(mimeType) {
  const blob = new Blob(audioChunks, { type: mimeType });

  // Local preview
  $audioPlayback.src     = URL.createObjectURL(blob);
  $audioPlayback.style.display = 'block';
  setAudioStatus('Wird hochgeladen…');

  try {
    const ext      = mimeType.includes('webm') ? 'webm' : 'ogg';
    const language = current?.language || 'german';
    const form     = new FormData();
    form.append('audio',      blob, `recording.${ext}`);
    form.append('language',   language);
    form.append('transcript', recordedTranscript);

    const res  = await fetch('/upload/audio', { method: 'POST', body: form });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).error ?? ''; } catch (_) {}
      const msg = `HTTP ${res.status}${detail ? ': ' + detail : ''}`;
      console.error('[Upload Audio]', msg);
      throw new Error(msg);
    }
    const json = await res.json();
    console.log('[Upload Audio] Response:', json);
    recordedAudioUrl = json.audio_url;

    // On translation: use the translated text as the answer
    if (json.translated_text) {
      recordedTranscript = json.translated_text;
      updateTranscriptDisplay(recordedTranscript);
    }

    setAudioStatus(`✔ Bereit — ${$recTimer.textContent}`);
  } catch (e) {
    setAudioStatus(`Upload fehlgeschlagen: ${e.message}`);
  }
}

function setAudioStatus(msg) {
  $audioStatus.textContent = msg;
}

function resetAudioRecorder() {
  stopRecording();
  audioChunks        = [];
  recordedAudioUrl   = null;
  recordedTranscript = '';
  $audioPlayback.style.display = 'none';
  $audioPlayback.src = '';
  $recTimer.textContent = '00:00';
  setAudioStatus('');
  updateTranscriptDisplay('');
}

// ── Toast ──────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className   = 'show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3000);
}

// ── Init ───────────────────────────────────────────────────────────────────
connect();
