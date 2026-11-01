import './style.css';
import { LayeredDepthRenderer } from './layeredRenderer.js';
import { CanvasFallbackRenderer } from './canvasFallbackRenderer.js';
const MOBILE_DEVICE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && Math.min(innerWidth, innerHeight) < 1100);
import { cancelDepthEstimation, estimateDepth, fileToCanvas, makeBasicDepth, processDepth, remapDepthCanvas, buildLayerPack } from './depth.js';
import { makeInteractiveHTML } from './exportScene.js';

const $ = (id) => document.getElementById(id);
const elements = {
  file: $('photoInput'),
  dropzone: $('dropzone'),
  emptyUpload: $('emptyUploadBtn'),
  emptyState: $('emptyState'),
  sceneMount: $('sceneMount'),
  viewer: $('viewer'),
  fileMetadata: $('fileMetadata'),
  fileLabel: $('fileLabel'),
  fileSize: $('fileSize'),
  uploadTitle: $('uploadTitle'),
  uploadSubtitle: $('uploadSubtitle'),
  uploadCTA: $('uploadCTA'),
  statusIcon: $('statusIcon'),
  statusTitle: $('statusTitle'),
  statusDetail: $('statusDetail'),
  progressTrack: $('progressTrack'),
  progressFill: $('progressFill'),
  fallbackBtn: $('fallbackBtn'),
  viewerLoading: $('viewerLoading'),
  loadingLabel: $('loadingLabel'),
  loadingSubLabel: $('loadingSubLabel'),
  sceneTab: $('sceneTab'),
  depthTab: $('depthTab'),
  depthView: $('depthView'),
  depthLarge: $('depthLarge'),
  resolutionLabel: $('resolutionLabel'),
  renderLabel: $('renderLabel'),
  viewHint: $('viewHint'),
  viewCounter: $('viewCounter'),
  reset: $('resetControlsBtn'),
  invert: $('invertDepth'),
  auto: $('autoAnimate'),
  strength: $('depthStrength'),
  motion: $('motionStrength'),
  blur: $('depthBlur'),
  contrast: $('depthContrast'),
  recenter: $('recenterBtn'),
  fullscreen: $('fullscreenBtn'),
  exportHtml: $('exportHtmlBtn'),
  exportPng: $('exportPngBtn'),
  exportDepth: $('exportDepthBtn'),
  exportVideo: $('exportVideoBtn'),
  videoFormat: $('videoFormat'),
  toast: $('toast'),
};

const DEFAULTS = { strength: 95, motion: 82, blur: 2, contrast: 120, invert: false, auto: true };
const PRESETS = {
  natural: { ...DEFAULTS },
  cinematic: { strength: 115, motion: 85, blur: 2, contrast: 130, invert: false, auto: true },
  dreamy: { strength: 45, motion: 38, blur: 9, contrast: 82, invert: false, auto: true },
};
const state = {
  photoCanvas: null,
  rawDepthCanvas: null,
  processedDepthCanvas: null,
  sourceName: '',
  token: 0,
  hasAiDepth: false,
  aiPending: false,
  recording: false,
  usingCanvasFallback: false,
  depthFilterKey: null,
  layerPack: null,
};
let renderer;
let toastTimer;

const angleChanged = (x, y) => {
  elements.viewCounter.textContent = `${Math.round(x).toString().padStart(2, '0')}° / ${Math.round(y).toString().padStart(2, '0')}°`;
};
try {
  renderer = new LayeredDepthRenderer(elements.sceneMount, angleChanged);
} catch (error) {
  console.warn('WebGL could not start, using 2D compatibility preview:', error);
  try {
    renderer = new CanvasFallbackRenderer(elements.sceneMount, angleChanged);
    state.usingCanvasFallback = true;
    setStatus('Compatibility preview', '2D canvas fallback active.', 'ready');
  } catch (fallbackError) {
    console.error(fallbackError);
    setStatus('Preview unavailable', 'This device does not support the rendering features required.', 'error');
    elements.viewerLoading.hidden = false;
    elements.loadingLabel.textContent = 'Preview unavailable';
  }
}

function toast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove('visible'), 3500);
}

function setStatus(title, detail, kind = 'ready') {
  elements.statusTitle.textContent = title;
  elements.statusDetail.textContent = detail;
  elements.statusIcon.className = `status-icon ${kind === 'ready' ? '' : kind}`;
}

function setLoading(isLoading, title = 'Generating 2.5D scene', detail = 'Creating your depth map…') {
  elements.viewerLoading.hidden = !isLoading;
  elements.loadingLabel.textContent = title;
  elements.loadingSubLabel.textContent = detail;
  elements.progressTrack.hidden = !isLoading;
  if (isLoading) elements.progressFill.style.width = '10%';
}

function currentSettings() {
  return {
    strength: Number(elements.strength.value) / 100,
    motion: Number(elements.motion.value) / 100,
    blur: Number(elements.blur.value),
    contrast: Number(elements.contrast.value) / 100,
    invert: elements.invert.checked,
    auto: elements.auto.checked,
  };
}

function updateSliderLabel(slider, label, value, percent = true) {
  label.textContent = `${value}${percent ? '%' : ' px'}`;
  const fraction = (Number(slider.value) - Number(slider.min)) / (Number(slider.max) - Number(slider.min));
  slider.style.setProperty('--fill', `${(fraction * 100).toFixed(2)}%`);
}

function refreshSliderLabels() {
  updateSliderLabel(elements.strength, $('depthStrengthValue'), elements.strength.value);
  updateSliderLabel(elements.motion, $('motionStrengthValue'), elements.motion.value);
  updateSliderLabel(elements.blur, $('depthBlurValue'), elements.blur.value, false);
  updateSliderLabel(elements.contrast, $('depthContrastValue'), elements.contrast.value);
}

function setPreset(preset) {
  const settings = PRESETS[preset];
  if (!settings) return;
  elements.strength.value = settings.strength;
  elements.motion.value = settings.motion;
  elements.blur.value = settings.blur;
  elements.contrast.value = settings.contrast;
  elements.invert.checked = settings.invert;
  elements.auto.checked = settings.auto;
  document.querySelectorAll('.preset').forEach((el) => el.classList.toggle('active', el.dataset.preset === preset));
  applySettings();
}

function applySettings() {
  refreshSliderLabels();
  if (!renderer) return;
  const settings = currentSettings();
  renderer.setSettings({ strength: settings.strength, motion: settings.motion, auto: settings.auto });
  // Rebuild textures only if image-processing settings change. Motion/depth
  // sliders update transforms without allocating new GPU textures.
  if (state.rawDepthCanvas) {
    const key = [settings.blur, settings.contrast, settings.invert].join('|');
    if (key !== state.depthFilterKey) updateDepthPreview();
  }
  const active = Object.keys(PRESETS).find((key) => {
    const s = PRESETS[key];
    return Math.round(settings.strength * 100) === s.strength && Math.round(settings.motion * 100) === s.motion &&
      settings.blur === s.blur && Math.round(settings.contrast * 100) === s.contrast && settings.invert === s.invert && settings.auto === s.auto;
  });
  document.querySelectorAll('.preset').forEach((el) => el.classList.toggle('active', el.dataset.preset === active));
}

function setReadyActions(ready) {
  elements.exportHtml.disabled = !ready;
  elements.exportPng.disabled = !ready;
  elements.exportDepth.disabled = !ready;
  elements.exportVideo.disabled = !ready || !recordingType || state.recording;
  if (!recordingType) elements.exportVideo.title = 'Animated export is not supported by this browser. Interactive HTML export still works.';
}

function showView(view) {
  if (!state.photoCanvas && view === 'depth') return;
  const isDepth = view === 'depth';
  elements.sceneTab.classList.toggle('active', !isDepth);
  elements.sceneTab.setAttribute('aria-selected', String(!isDepth));
  elements.depthTab.classList.toggle('active', isDepth);
  elements.depthTab.setAttribute('aria-selected', String(isDepth));
  elements.depthView.hidden = !isDepth;
  elements.sceneMount.hidden = isDepth;
  elements.viewHint.textContent = isDepth ? 'ESTIMATED RELATIVE DISTANCE' : 'DRAG TO CHANGE PERSPECTIVE';
}

function updateDepthPreview() {
  if (!state.rawDepthCanvas || !state.photoCanvas || !renderer) return;
  const settings = currentSettings();
  const processed = processDepth(state.rawDepthCanvas, settings);
  const remapped = remapDepthCanvas(processed);
  state.processedDepthCanvas = remapped;
  state.depthFilterKey = [settings.blur, settings.contrast, settings.invert].join('|');
  elements.depthLarge.width = remapped.width;
  elements.depthLarge.height = remapped.height;
  elements.depthLarge.getContext('2d').drawImage(remapped, 0, 0);
  if (state.usingCanvasFallback) {
    renderer.setScene(state.photoCanvas);
  } else {
    const pack = buildLayerPack(state.photoCanvas, remapped, { mobile: MOBILE_DEVICE });
    state.layerPack = pack;
    renderer.setScene(pack);
  }
}

function makeFlatDepth() {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 2;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, 2, 2);
  return canvas;
}

async function openPhoto(file, { forceAI = false } = {}) {
  if (!renderer || !file) return;
  cancelDepthEstimation();
  const token = ++state.token;
  state.photoCanvas = null;
  state.rawDepthCanvas = null;
  state.processedDepthCanvas = null;
  state.layerPack = null;
  state.depthFilterKey = null;
  state.sourceName = file.name;
  state.hasAiDepth = false;
  state.aiPending = false;
  elements.fallbackBtn.hidden = true;
  setReadyActions(false);
  showView('scene');
  setLoading(true, 'Opening your photo', 'Preparing image for private local processing…');
  setStatus('Preparing your photo', 'Images are processed in your browser.', 'busy');
  try {
    const photoCanvas = await fileToCanvas(file, MOBILE_DEVICE ? 960 : 1600);
    if (token !== state.token) return;
    state.photoCanvas = photoCanvas;
    state.sourceName = file.name.replace(/\.[^.]+$/, '') || 'photo';
    elements.fileMetadata.hidden = false;
    elements.fileLabel.textContent = file.name;
    elements.fileSize.textContent = `${Math.max(1, Math.round(file.size / 1024))} KB`;
    elements.uploadTitle.textContent = 'Change your photo';
    elements.uploadSubtitle.textContent = 'Click here or drop another image';
    elements.uploadCTA.textContent = 'CHOOSE ANOTHER PHOTO ↗';
    elements.emptyState.hidden = true;
    elements.resolutionLabel.textContent = `PROJECT / ${photoCanvas.width} × ${photoCanvas.height}`;
    elements.renderLabel.textContent = 'DEPTHROOM / PROCESSING';
    // The layered scene is created by updateDepthPreview below.
    // Give users a usable preview even if the AI model cannot initialize.
    state.rawDepthCanvas = makeBasicDepth(photoCanvas.width, photoCanvas.height);
    updateDepthPreview();
    applySettings();
    setReadyActions(true);
    setLoading(false);
    elements.progressTrack.hidden = false;
    elements.progressFill.style.width = '10%';
    if (MOBILE_DEVICE && !forceAI) {
      // Starting a large AI runtime automatically can make an iPhone's browser tab crash.
      elements.progressTrack.hidden = true;
      elements.renderLabel.textContent = state.usingCanvasFallback
        ? 'DEPTHROOM / CANVAS PREVIEW' : 'DEPTHROOM / LAYERED QUICK DEPTH';
      setStatus('Mobile preview ready',
        'Your photo is ready. AI Enhance is optional on phones.', 'ready');
      elements.fallbackBtn.hidden = false;
      elements.fallbackBtn.textContent = 'AI Enhance (optional) →';
      return;
    }
    setStatus('Refining depth with AI', 'You can explore the quick preview while the model works.', 'busy');
    state.aiPending = true;
    elements.fallbackBtn.hidden = false;
    elements.fallbackBtn.textContent = 'Use quick depth now →';
    const onProgress = ({ percent, detail }) => {
      if (token !== state.token || !state.aiPending) return;
      if (typeof percent === 'number') {
        elements.progressFill.style.width = `${Math.max(10, percent)}%`;
      }
      if (detail) {
        elements.loadingSubLabel.textContent = detail;
        elements.statusDetail.textContent = detail;
      }
    };
    let depth;
    try {
      const inferenceCanvas = document.createElement('canvas');
      const maxSide = MOBILE_DEVICE ? 280 : 512;
      const scale = Math.min(1, maxSide / Math.max(photoCanvas.width, photoCanvas.height));
      inferenceCanvas.width = Math.max(1, Math.round(photoCanvas.width * scale));
      inferenceCanvas.height = Math.max(1, Math.round(photoCanvas.height * scale));
      inferenceCanvas.getContext('2d').drawImage(photoCanvas, 0, 0, inferenceCanvas.width, inferenceCanvas.height);
      const prepared = inferenceCanvas.toDataURL('image/jpeg', MOBILE_DEVICE ? .75 : .85);
      inferenceCanvas.width = 0;
      inferenceCanvas.height = 0;
      depth = await estimateDepth(prepared, onProgress);
      if (token !== state.token || !state.aiPending) return;
      state.aiPending = false;
      state.hasAiDepth = true;
      elements.fallbackBtn.hidden = true;
      elements.progressTrack.hidden = true;
      setStatus('AI depth map ready', 'Estimated locally. Drag the image to explore.', 'ready');
      elements.renderLabel.textContent = 'DEPTHROOM / CLEAN DEPTH';
    } catch (error) {
      if (token !== state.token || !state.aiPending) return;
      state.aiPending = false;
      console.warn('Depth model failed:', error);
      depth = state.rawDepthCanvas || makeBasicDepth(photoCanvas.width, photoCanvas.height);
      state.hasAiDepth = false;
      elements.progressTrack.hidden = true;
      setStatus('Basic depth mode', `${error?.message || 'AI unavailable.'} Showing an approximate depth effect.`, 'error');
      elements.renderLabel.textContent = 'DEPTHROOM / LAYERED BASIC';
      elements.fallbackBtn.hidden = false;
      elements.fallbackBtn.textContent = 'Retry AI depth →';
      toast('AI depth was unavailable; showing an approximate depth effect.');
    }
    state.rawDepthCanvas = depth;
    updateDepthPreview();
    setReadyActions(true);
    setLoading(false);
  } catch (error) {
    if (token !== state.token) return;
    setLoading(false);
    setStatus('Unable to open photo', error?.message || 'Please try another image.', 'error');
    toast(error?.message || 'Unable to open this photo.');
    if (!state.photoCanvas) elements.emptyState.hidden = false;
  }
}

function downloadUrl(url, filename) {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  downloadUrl(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function safeName() {
  return (state.sourceName || 'my-photo').replace(/[^a-z0-9-_]/gi, '-').replace(/-+/g, '-').slice(0, 55);
}

function detectRecordingType() {
  if (typeof MediaRecorder === 'undefined') return null;
  const types = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || null;
}
const recordingType = detectRecordingType();
elements.videoFormat.textContent = recordingType?.includes('mp4') ? '(MP4)' : recordingType ? '(WEBM)' : '(UNSUPPORTED)';

async function recordLoop() {
  if (!renderer || !recordingType || state.recording) return;
  const canvas = renderer.canvas();
  if (!canvas.captureStream) {
    toast('Recording is unavailable in this browser. Export interactive HTML instead.');
    return;
  }
  let stream;
  let recorder;
  try {
    stream = canvas.captureStream(30);
    recorder = new MediaRecorder(stream, { mimeType: recordingType, videoBitsPerSecond: 8000000 });
  } catch (error) {
    toast('This browser cannot record the 3D canvas. Try interactive HTML export.');
    return;
  }
  const chunks = [];
  state.recording = true;
  elements.exportVideo.disabled = true;
  elements.exportVideo.textContent = '● RECORDING YOUR LOOP…';
  showView('scene');
  renderer.startRecordingMotion();
  recorder.addEventListener('dataavailable', (e) => { if (e.data.size > 0) chunks.push(e.data); });
  recorder.addEventListener('stop', () => {
    renderer.stopRecordingMotion();
    stream.getTracks().forEach((track) => track.stop());
    state.recording = false;
    elements.exportVideo.innerHTML = `◉ EXPORT ANIMATED LOOP <span>${recordingType.includes('mp4') ? '(MP4)' : '(WEBM)'}</span>`;
    setReadyActions(!!state.rawDepthCanvas);
    if (chunks.length) {
      const ext = recordingType.includes('mp4') ? 'mp4' : 'webm';
      downloadBlob(new Blob(chunks, { type: recordingType }), `depthroom-${safeName()}.${ext}`);
      toast('Your animated loop was exported.');
    } else {
      toast('Recording produced no frames in this browser.');
    }
  });
  recorder.addEventListener('error', () => {
    if (recorder.state !== 'inactive') recorder.stop();
    toast('Unable to record this browser session.');
  });
  try {
    recorder.start(100);
    await new Promise((resolve) => setTimeout(resolve, 4200));
    if (recorder.state !== 'inactive') recorder.stop();
  } catch (error) {
    if (recorder.state !== 'inactive') recorder.stop();
  }
}

// Upload / drag and drop
[elements.emptyUpload].forEach((button) => button.addEventListener('click', () => elements.file.click()));
elements.file.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) openPhoto(file);
  elements.file.value = '';
});
elements.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); elements.file.click(); }
});
for (const type of ['dragenter', 'dragover']) elements.dropzone.addEventListener(type, (e) => {
  e.preventDefault(); elements.dropzone.classList.add('drag-over');
});
for (const type of ['dragleave', 'drop']) elements.dropzone.addEventListener(type, (e) => {
  e.preventDefault(); elements.dropzone.classList.remove('drag-over');
});
elements.dropzone.addEventListener('drop', (e) => {
  const file = Array.from(e.dataTransfer?.files || []).find((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
  if (file) openPhoto(file);
  else toast('Please drop a JPG, PNG, WebP, HEIC, or HEIF image.');
});

// Controls
[elements.strength, elements.motion].forEach((slider) => slider.addEventListener('input', applySettings));
let depthAdjustmentTimer;
[elements.blur, elements.contrast, elements.invert].forEach((input) => input.addEventListener('input', () => {
  clearTimeout(depthAdjustmentTimer);
  depthAdjustmentTimer = setTimeout(applySettings, MOBILE_DEVICE ? 150 : 70);
}));
elements.auto.addEventListener('change', applySettings);
elements.reset.addEventListener('click', () => setPreset('natural'));
document.querySelectorAll('.preset').forEach((button) => button.addEventListener('click', () => setPreset(button.dataset.preset)));
elements.fallbackBtn.addEventListener('click', () => {
  if (state.aiPending && state.photoCanvas) {
    state.aiPending = false;
    cancelDepthEstimation();
    state.rawDepthCanvas = makeBasicDepth(state.photoCanvas.width, state.photoCanvas.height);
    state.hasAiDepth = false;
    elements.renderLabel.textContent = 'DEPTHROOM / LAYERED BASIC';
    setStatus('Quick depth ready', 'Approximate depth preview. Retry AI depth for more accuracy.', 'ready');
    elements.progressTrack.hidden = true;
    elements.fallbackBtn.textContent = 'Retry AI depth →';
    updateDepthPreview();
    setReadyActions(true);
    setLoading(false);
    return;
  }
  if (state.photoCanvas) {
    const image = new File([dataURLToBlob(state.photoCanvas.toDataURL('image/jpeg', .94))], `${safeName()}.jpg`, { type: 'image/jpeg' });
    openPhoto(image, { forceAI: true });
  }
});

function dataURLToBlob(dataURL) {
  const parts = dataURL.split(',');
  const bytes = atob(parts[1]);
  const buffer = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) buffer[i] = bytes.charCodeAt(i);
  return new Blob([buffer], { type: parts[0].split(':')[1].split(';')[0] });
}

elements.sceneTab.addEventListener('click', () => showView('scene'));
elements.depthTab.addEventListener('click', () => showView('depth'));
elements.recenter.addEventListener('click', () => renderer?.recenter());
elements.fullscreen.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (elements.viewer.requestFullscreen) await elements.viewer.requestFullscreen();
    else toast('Fullscreen mode is not supported in this browser.');
  } catch { toast('Fullscreen mode is unavailable.'); }
});

elements.exportPng.addEventListener('click', () => {
  if (!renderer || !state.photoCanvas) return;
  showView('scene');
  requestAnimationFrame(() => {
    downloadUrl(renderer.exportPng(), `depthroom-${safeName()}.png`);
    toast('Current perspective saved as PNG.');
  });
});
elements.exportDepth.addEventListener('click', () => {
  if (!state.processedDepthCanvas) return;
  downloadUrl(state.processedDepthCanvas.toDataURL('image/png'), `depthroom-${safeName()}-depth.png`);
  toast('Depth map saved as PNG.');
});
elements.exportHtml.addEventListener('click', () => {
  if (!state.photoCanvas || !state.processedDepthCanvas) return;
  const html = makeInteractiveHTML(
    state.photoCanvas.toDataURL('image/jpeg', .92),
    state.processedDepthCanvas.toDataURL('image/png'),
    currentSettings(),
  );
  downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `depthroom-${safeName()}.html`);
  toast('Interactive 2.5D HTML exported — image and depth are embedded.');
});
elements.exportVideo.addEventListener('click', recordLoop);
refreshSliderLabels();
setReadyActions(false);