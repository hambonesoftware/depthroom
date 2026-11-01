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

const clamp01 = value => Math.max(0, Math.min(1, value));
const ease = (a, b, value) => {
  const t = clamp01((value - a) / Math.max(1e-5, b - a));
  return t * t * (3 - 2 * t);
};
const newCanvas = (width, height) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

/**
 * Auto-levels the grayscale prediction using percentiles. Unlike fixed depth
 * thresholds, percentile bands remain useful on bright or low-contrast images.
 */
export function remapDepthCanvas(input) {
  const width = input.width;
  const height = input.height;
  const source = input.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height);
  const histogram = new Uint32Array(256);
  for (let i = 0; i < source.data.length; i += 16) histogram[source.data[i]]++;
  const total = histogram.reduce((sum, value) => sum + value, 0);
  const percentile = fraction => {
    let running = 0;
    for (let i = 0; i < 256; i++) {
      running += histogram[i];
      if (running >= total * fraction) return i;
    }
    return 255;
  };
  const lower = percentile(.04);
  const upper = percentile(.96);
  const spread = Math.max(24, upper - lower);
  const output = newCanvas(width, height);
  const pixels = output.getContext('2d').createImageData(width, height);
  for (let i = 0; i < source.data.length; i += 4) {
    const normalized = clamp01((source.data[i] - lower) / spread);
    const mapped = Math.round(255 * ease(0, 1, Math.pow(normalized, .93)));
    pixels.data[i] = mapped;
    pixels.data[i + 1] = mapped;
    pixels.data[i + 2] = mapped;
    pixels.data[i + 3] = 255;
  }
  output.getContext('2d').putImageData(pixels, 0, 0);
  return output;
}

/**
 * Reconstructs an approximate backdrop by filling masked foreground regions
 * from the nearest available pixels on each scanline. It is not generative
 * inpainting, but avoids simply duplicating the people behind themselves.
 */
function makeBackground(photo, depthValues, width, height, exclusionThreshold) {
  const coarseWidth = Math.min(320, width);
  const coarseHeight = Math.max(2, Math.round(coarseWidth * height / width));
  const small = newCanvas(coarseWidth, coarseHeight);
  const ctx = small.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(photo, 0, 0, coarseWidth, coarseHeight);
  const data = ctx.getImageData(0, 0, coarseWidth, coarseHeight);
  const image = data.data;
  const samples = new Uint8Array(coarseWidth * coarseHeight);
  for (let y = 0; y < coarseHeight; y++) {
    for (let x = 0; x < coarseWidth; x++) {
      const ux = Math.min(width - 1, Math.round(x * width / coarseWidth));
      const uy = Math.min(height - 1, Math.round(y * height / coarseHeight));
      samples[y * coarseWidth + x] = depthValues[uy * width + ux];
    }
  }
  for (let y = 0; y < coarseHeight; y++) {
    const left = new Int32Array(coarseWidth);
    const right = new Int32Array(coarseWidth);
    let good = -1;
    for (let x = 0; x < coarseWidth; x++) {
      if (samples[y * coarseWidth + x] < exclusionThreshold) good = x;
      left[x] = good;
    }
    good = -1;
    for (let x = coarseWidth - 1; x >= 0; x--) {
      if (samples[y * coarseWidth + x] < exclusionThreshold) good = x;
      right[x] = good;
    }
    for (let x = 0; x < coarseWidth; x++) {
      if (samples[y * coarseWidth + x] < exclusionThreshold) continue;
      const a = left[x], b = right[x];
      const nearest = a < 0 ? b : b < 0 ? a :
        (x - a < b - x ? a : b);
      if (nearest < 0) continue;
      const src = (y * coarseWidth + nearest) * 4;
      const dst = (y * coarseWidth + x) * 4;
      image[dst] = image[src];
      image[dst + 1] = image[src + 1];
      image[dst + 2] = image[src + 2];
    }
  }
  ctx.putImageData(data, 0, 0);
  const background = newCanvas(width, height);
  const out = background.getContext('2d');
  out.filter = 'blur(8px)';
  out.drawImage(small, -10, -10, width + 20, height + 20);
  out.filter = 'none';
  // Restore texture in uncovered regions of the scene.
  const restored = out.createImageData(width, height);
  const original = photo.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height);
  for (let i = 0; i < depthValues.length; i++) {
    const alpha = 1 - ease(exclusionThreshold - 16, exclusionThreshold + 5, depthValues[i]);
    const j = i * 4;
    restored.data[j] = original.data[j];
    restored.data[j + 1] = original.data[j + 1];
    restored.data[j + 2] = original.data[j + 2];
    restored.data[j + 3] = Math.round(alpha * 255);
  }
  const detail = newCanvas(width, height);
  detail.getContext('2d').putImageData(restored, 0, 0);
  out.drawImage(detail, 0, 0);
  return background;
}

/**
 * Creates an opaque reconstructed background and four alpha-feathered
 * foreground bands. Uses a capped pixel budget to avoid GPU memory spikes on
 * mobile Safari. Bands are scene-depth regions, not semantic people masks.
 */
export function buildLayerPack(photoCanvas, depthCanvas, { mobile = false } = {}) {
  const maxSide = mobile ? 800 : 1152;
  const ratio = Math.min(1, maxSide / Math.max(photoCanvas.width, photoCanvas.height));
  const width = Math.max(2, Math.round(photoCanvas.width * ratio));
  const height = Math.max(2, Math.round(photoCanvas.height * ratio));
  const photo = newCanvas(width, height);
  photo.getContext('2d').drawImage(photoCanvas, 0, 0, width, height);
  const depth = newCanvas(width, height);
  depth.getContext('2d').drawImage(depthCanvas, 0, 0, width, height);
  const rgba = photo.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height);
  const depthRgba = depth.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height).data;
  const samples = new Uint8Array(width * height);
  const histogram = new Uint32Array(256);
  for (let i = 0; i < samples.length; i++) {
    const d = depthRgba[i * 4];
    samples[i] = d;
    histogram[d]++;
  }
  const percentile = q => {
    let soFar = 0;
    const target = samples.length * q;
    for (let i = 0; i < 256; i++) {
      soFar += histogram[i];
      if (soFar >= target) return i;
    }
    return 255;
  };
  const rawCuts = [.22, .44, .66, .84].map(percentile);
  const cuts = [];
  for (let i = 0; i < rawCuts.length; i++) {
    cuts.push(Math.min(246, Math.max(i ? cuts[i - 1] + 14 : 22, rawCuts[i])));
  }
  const nearThreshold = cuts[2];
  const bg = makeBackground(photo, samples, width, height, nearThreshold);
  const layers = [{
    name: 'background',
    canvas: bg,
    z: -.38,
    parallax: -.31,
    scale: 1.075,
  }];
  const z = [-.24, -.06, .13, .34];
  const parallax = [-.12, .22, .65, 1.15];
  const widths = [11, 11, 10, 9];
  // Near layers overlap softly to avoid hard stair-step boundaries.
  for (let band = 0; band < 4; band++) {
    const low = cuts[band];
    const high = band < 3 ? cuts[band + 1] : 275;
    const feather = widths[band];
    const layerCanvas = newCanvas(width, height);
    const context = layerCanvas.getContext('2d');
    const layer = context.createImageData(width, height);
    for (let i = 0; i < samples.length; i++) {
      const value = samples[i];
      const enter = ease(low - feather, low + feather, value);
      const exit = band === 3 ? 1 : 1 - ease(high - feather, high + feather, value);
      const alpha = enter * exit;
      if (alpha < .006) continue;
      const j = i * 4;
      layer.data[j] = rgba.data[j];
      layer.data[j + 1] = rgba.data[j + 1];
      layer.data[j + 2] = rgba.data[j + 2];
      layer.data[j + 3] = Math.round(alpha * 255);
    }
    context.putImageData(layer, 0, 0);
    layers.push({
      name: 'depth-band-' + (band + 1),
      canvas: layerCanvas,
      z: z[band],
      parallax: parallax[band],
      scale: 1,
    });
  }
  return { width, height, layers };
}
