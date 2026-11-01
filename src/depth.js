/** Depth Anything V2 runs completely in the client via Transformers.js. */
const MODEL_ID = 'onnx-community/depth-anything-v2-small';
let estimatorPromise = null;

async function makeEstimator(onProgress = () => {}) {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.allowRemoteModels = true;
  // The model files are fetched from Hugging Face, not a photo-processing API.
  const options = (device) => ({
    device,
    progress_callback: (event) => {
      if (event.status === 'progress' && typeof event.progress === 'number') {
        onProgress({ percent: Math.min(99, Math.max(0, event.progress)), detail: 'Downloading AI model…' });
      } else if (event.status === 'ready') {
        onProgress({ percent: 100, detail: 'Model ready' });
      } else if (event.status === 'initiate' || event.status === 'download') {
        onProgress({ percent: null, detail: 'Loading AI model…' });
      }
    },
  });
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        onProgress({ percent: null, detail: 'Starting GPU depth estimation…' });
        return await pipeline('depth-estimation', MODEL_ID, options('webgpu'));
      }
    } catch (err) {
      console.warn('WebGPU unavailable, switching to WASM', err);
    }
  }
  onProgress({ percent: null, detail: 'Loading CPU depth estimation…' });
  return pipeline('depth-estimation', MODEL_ID, options('wasm'));
}

export async function estimateDepth(imageURL, onProgress = () => {}) {
  if (!estimatorPromise) {
    estimatorPromise = makeEstimator(onProgress).catch((error) => {
      estimatorPromise = null;
      throw error;
    });
  }
  const estimator = await estimatorPromise;
  onProgress({ percent: null, detail: 'Estimating foreground and background…' });
  const prediction = await estimator(imageURL);
  const depth = Array.isArray(prediction) ? prediction[0] : prediction;
  if (!depth) throw new Error('The AI model returned no depth information.');

  const output = depth.depth;
  if (output && output.width && output.height && output.data) {
    const { width, height, channels, data } = output;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = ctx.createImageData(width, height);
    const stride = channels || Math.max(1, Math.round(data.length / (width * height)));
    for (let i = 0; i < width * height; i += 1) {
      const value = stride === 1
        ? data[i]
        : 0.299 * data[i * stride] + 0.587 * data[i * stride + 1] + 0.114 * data[i * stride + 2];
      const j = i * 4;
      rgba.data[j] = value;
      rgba.data[j + 1] = value;
      rgba.data[j + 2] = value;
      rgba.data[j + 3] = 255;
    }
    ctx.putImageData(rgba, 0, 0);
    return canvas;
  }

  const tensor = depth.predicted_depth;
  if (!tensor?.data || !tensor?.dims) throw new Error('Depth output was in an unknown format.');
  const h = tensor.dims[tensor.dims.length - 2];
  const w = tensor.dims[tensor.dims.length - 1];
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(w, h);
  const samples = tensor.data;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < samples.length; i += 1) {
    min = Math.min(min, samples[i]);
    max = Math.max(max, samples[i]);
  }
  for (let i = 0; i < w * h; i += 1) {
    const v = Math.round(255 * (samples[i] - min) / Math.max(1e-6, max - min));
    image.data.set([v, v, v, 255], i * 4);
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
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