/** Depth inference is isolated in a disposable worker to protect the UI thread. */
let activeRun = null;

export function cancelDepthEstimation() {
  if (!activeRun) return;
  const previous = activeRun;
  activeRun = null;
  previous.reject(new DOMException('Depth estimation cancelled.', 'AbortError'));
}

export function estimateDepth(imageURL, onProgress = () => {}) {
  cancelDepthEstimation();
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./depthWorker.js', import.meta.url), { type: 'module' });
    } catch (error) {
      reject(error);
      return;
    }
    let stageTimeout;
    let totalTimeout;
    let finished = false;
    const cleanup = () => {
      clearTimeout(stageTimeout);
      clearTimeout(totalTimeout);
      worker.terminate();
    };
    const fail = (error) => {
      if (finished) return;
      finished = true;
      if (activeRun?.worker === worker) activeRun = null;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const watch = (stage) => {
      clearTimeout(stageTimeout);
      const limit = stage === 'estimating' ? 85000 : stage === 'starting' ? 25000 : 65000;
      stageTimeout = setTimeout(() => fail(new Error(
        stage === 'estimating'
          ? 'AI inference took too long on this device.'
          : 'The depth model stopped responding while loading.'
      )), limit);
    };
    activeRun = { worker, reject: fail };
    watch('starting');
    totalTimeout = setTimeout(() => fail(new Error('The AI model exceeded the processing time limit.')), 140000);
    worker.onmessage = ({ data }) => {
      if (finished) return;
      if (data?.type === 'progress') {
        watch(data.stage || 'loading');
        onProgress({ percent: data.percent, detail: data.detail });
      } else if (data?.type === 'error') {
        fail(new Error(data.message || 'AI depth processing failed.'));
      } else if (data?.type === 'result') {
        try {
          const { width, height } = data;
          if (!width || !height || width * height > 10000000) throw new Error('Invalid depth map resolution.');
          const samples = new Uint8ClampedArray(data.grayscale);
          if (samples.length !== width * height) throw new Error('Incomplete depth map.');
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          const rgba = ctx.createImageData(width, height);
          for (let i = 0; i < samples.length; i += 1) {
            const j = i * 4;
            rgba.data[j] = samples[i];
            rgba.data[j + 1] = samples[i];
            rgba.data[j + 2] = samples[i];
            rgba.data[j + 3] = 255;
          }
          ctx.putImageData(rgba, 0, 0);
          finished = true;
          activeRun = null;
          cleanup();
          resolve(canvas);
        } catch (error) {
          fail(error);
        }
      }
    };
    worker.onerror = (event) => fail(new Error(event.message || 'The depth worker crashed.'));
    worker.onmessageerror = () => fail(new Error('The depth worker returned unreadable data.'));
    try {
      worker.postMessage({ type: 'estimate', imageURL });
    } catch (error) {
      fail(error);
    }
  });
}

export function makeBasicDepth(width, height) {
  const w = Math.min(512, width);
  const h = Math.max(2, Math.round(w * height / width));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  // Clearly marked geometric fallback, not a purported AI prediction.
  for (let y = 0; y < h; y += 1) {
    const ny = y / (h - 1);
    for (let x = 0; x < w; x += 1) {
      const nx = x / Math.max(1, w - 1);
      const focus = Math.exp(-((nx - .5) ** 2 / .11 + (ny - .55) ** 2 / .19));
      const v = Math.min(255, Math.max(0, Math.round(255 * (.10 + .69 * ny + .20 * focus))));
      const i = (y * w + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export function processDepth(rawDepthCanvas, settings) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(1024, rawDepthCanvas.width);
  canvas.height = Math.max(1, Math.round(canvas.width * rawDepthCanvas.height / rawDepthCanvas.width));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (settings.blur > 0) ctx.filter = `blur(${settings.blur}px)`;
  ctx.drawImage(rawDepthCanvas, 0, 0, canvas.width, canvas.height);
  ctx.filter = 'none';
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const original = pixels.data[i];
    const contrast = 128 + (original - 128) * settings.contrast;
    const v = Math.min(255, Math.max(0, Math.round(settings.invert ? 255 - contrast : contrast)));
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = v;
    pixels.data[i + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas;
}

export async function fileToCanvas(file, maxSide = 1600) {
  if (file.size > 45 * 1024 * 1024) throw new Error('This image is over 45 MB. Please choose a smaller photo.');
  let blob = file;
  let img = null;
  async function loadImage(source) {
    const url = URL.createObjectURL(source);
    try {
      const loaded = new Image();
      loaded.decoding = 'async';
      loaded.src = url;
      await loaded.decode();
      return loaded;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  try {
    img = await loadImage(blob);
  } catch (firstError) {
    const heic = /\.(heic|heif)$/i.test(file.name) || /image\/hei[cf]/i.test(file.type);
    if (!heic) throw new Error('Could not open this image. Try a JPG, PNG, or WebP photo.');
    const { default: heic2any } = await import('heic2any');
    const converted = await heic2any({ blob: file, toType: 'image/jpeg', quality: .92 });
    blob = Array.isArray(converted) ? converted[0] : converted;
    img = await loadImage(blob);
  }
  if (img.naturalWidth < 4 || img.naturalHeight < 4) throw new Error('The photo is too small.');
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  // Re-encoding strips EXIF/GPS metadata from all downloadable exports.
  return canvas;
}