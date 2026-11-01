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
/**
 * Foreground reconstruction for the current depth-only model. Rather than
 * allowing a portrait to be divided across four moving planes, it uses one
 * foreground layer and a separately hole-filled background. Real instance
 * segmentation can replace this approximate mask in a later iteration.
 */
function makeFilledBackground(photo, depth, threshold) {
  const width = photo.width;
  const height = photo.height;
  const smallWidth = Math.min(320, width);
  const smallHeight = Math.max(2, Math.round(height * smallWidth / width));
  const small = newCanvas(smallWidth, smallHeight);
  const smallCtx = small.getContext('2d', { willReadFrequently: true });
  smallCtx.drawImage(photo, 0, 0, smallWidth, smallHeight);
  const rgba = smallCtx.getImageData(0, 0, smallWidth, smallHeight);
  const pixels = rgba.data;
  const smallDepth = newCanvas(smallWidth, smallHeight);
  const depthCtx = smallDepth.getContext('2d', { willReadFrequently: true });
  depthCtx.drawImage(depth, 0, 0, smallWidth, smallHeight);
  const depthData = depthCtx.getImageData(0, 0, smallWidth, smallHeight).data;
  const count = smallWidth * smallHeight;

  // Expand the mask slightly, covering remaining subject-edge colors before fill.
  let excluded = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    excluded[i] = depthData[i * 4] >= threshold - 15 ? 1 : 0;
  }
  for (let step = 0; step < 3; step++) {
    const expanded = excluded.slice();
    for (let y = 1; y < smallHeight - 1; y++) {
      for (let x = 1; x < smallWidth - 1; x++) {
        const i = y * smallWidth + x;
        if (!excluded[i]) continue;
        expanded[i - 1] = 1;
        expanded[i + 1] = 1;
        expanded[i - smallWidth] = 1;
        expanded[i + smallWidth] = 1;
      }
    }
    excluded = expanded;
  }

  // Multi-source 2-D flood fill. Nearest pixels come from the surrounding
  // scene in every direction, instead of horizontal row extension (striping).
  const seed = new Int32Array(count);
  seed.fill(-1);
  const queue = new Int32Array(count);
  let tail = 0;
  for (let i = 0; i < count; i++) {
    if (!excluded[i]) {
      seed[i] = i;
      queue[tail++] = i;
    }
  }
  // If no background is visible, use the original photo rather than black.
  if (!tail) return photo;
  let front = 0;
  while (front < tail) {
    const i = queue[front++];
    const x = i % smallWidth;
    const y = Math.floor(i / smallWidth);
    const adjacent = [
      x > 0 ? i - 1 : -1,
      x + 1 < smallWidth ? i + 1 : -1,
      y > 0 ? i - smallWidth : -1,
      y + 1 < smallHeight ? i + smallWidth : -1,
    ];
    for (const next of adjacent) {
      if (next < 0 || seed[next] !== -1) continue;
      seed[next] = seed[i];
      queue[tail++] = next;
    }
  }
  // Copy original pixels to avoid propagating an already overwritten source.
  const source = new Uint8ClampedArray(pixels);
  for (let i = 0; i < count; i++) {
    if (!excluded[i]) continue;
    const s = seed[i] * 4;
    const d = i * 4;
    pixels[d] = source[s];
    pixels[d + 1] = source[s + 1];
    pixels[d + 2] = source[s + 2];
    pixels[d + 3] = 255;
  }
  smallCtx.putImageData(rgba, 0, 0);

  const background = newCanvas(width, height);
  const backgroundCtx = background.getContext('2d');
  // Subtle smoothing only on the reconstructed plate; preserve real pixels
  // everywhere outside of the subject exclusion area.
  backgroundCtx.save();
  backgroundCtx.filter = 'blur(4px)';
  backgroundCtx.drawImage(small, -6, -6, width + 12, height + 12);
  backgroundCtx.restore();
  const original = photo.getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, width, height);
  const fullDepth = depth.getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, width, height).data;
  const restore = backgroundCtx.createImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const j = i * 4;
    const opacity = 1 - ease(threshold - 24, threshold - 8, fullDepth[j]);
    restore.data[j] = original.data[j];
    restore.data[j + 1] = original.data[j + 1];
    restore.data[j + 2] = original.data[j + 2];
    restore.data[j + 3] = Math.round(clamp01(opacity) * 255);
  }
  const restoreCanvas = newCanvas(width, height);
  restoreCanvas.getContext('2d').putImageData(restore, 0, 0);
  backgroundCtx.drawImage(restoreCanvas, 0, 0);
  return background;
}

/**
 * One intact near-field plane avoids splitting a face or body across several
 * offset layers. Background inpainting is approximate and intended for small
 * parallax displacements, not arbitrary camera movement.
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
  const pictureData = photo.getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, width, height).data;
  const depthData = depth.getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, width, height).data;
  const histogram = new Uint32Array(256);
  for (let i = 0; i < width * height; i++) histogram[depthData[i * 4]]++;
  const threshold = (() => {
    const target = width * height * .58;
    let cumulative = 0;
    for (let i = 0; i < 256; i++) {
      cumulative += histogram[i];
      if (cumulative >= target) return i;
    }
    return 128;
  })();

  const background = makeFilledBackground(photo, depth, threshold);
  const foreground = newCanvas(width, height);
  const foregroundCtx = foreground.getContext('2d');
  const cutout = foregroundCtx.createImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const j = i * 4;
    const alpha = ease(threshold - 15, threshold + 9, depthData[j]);
    if (alpha < .004) continue;
    cutout.data[j] = pictureData[j];
    cutout.data[j + 1] = pictureData[j + 1];
    cutout.data[j + 2] = pictureData[j + 2];
    cutout.data[j + 3] = Math.round(255 * alpha);
  }
  foregroundCtx.putImageData(cutout, 0, 0);
  return {
    width,
    height,
    layers: [
      { name: 'reconstructed-background', canvas: background, z: -.28, parallax: -.17, scale: 1.06 },
      { name: 'near-foreground', canvas: foreground, z: .23, parallax: .98, scale: 1 },
    ],
  };
}
