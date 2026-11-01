// Quantized Depth Anything V2 runs off the UI thread; failures can be safely terminated.
const MODEL_ID = 'onnx-community/depth-anything-v2-small';
const report = (detail, stage, percent = null) =>
  self.postMessage({ type: 'progress', detail, stage, percent });

function toGrayscale(result) {
  const depth = Array.isArray(result) ? result[0] : result;
  const output = depth?.depth;
  if (output?.width && output?.height && output?.data) {
    const { width, height, data } = output;
    const count = width * height;
    const stride = output.channels || Math.max(1, Math.round(data.length / count));
    const pixels = new Uint8ClampedArray(count);
    for (let i = 0; i < count; i += 1) {
      pixels[i] = stride === 1 ? data[i] :
        .299 * data[i * stride] + .587 * data[i * stride + 1] + .114 * data[i * stride + 2];
    }
    return { width, height, pixels };
  }
  const tensor = depth?.predicted_depth;
  if (!tensor?.data || !tensor?.dims) throw new Error('The depth model returned an unsupported result.');
  const height = tensor.dims[tensor.dims.length - 2];
  const width = tensor.dims[tensor.dims.length - 1];
  const values = tensor.data;
  const count = width * height;
  if (!width || !height || values.length < count) throw new Error('Invalid depth map size.');
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < count; i += 1) {
    if (Number.isFinite(values[i])) {
      min = Math.min(min, values[i]);
      max = Math.max(max, values[i]);
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error('The depth map contains no valid samples.');
  const pixels = new Uint8ClampedArray(count);
  const range = Math.max(1e-6, max - min);
  for (let i = 0; i < count; i += 1) {
    pixels[i] = Math.round(255 * (values[i] - min) / range);
  }
  return { width, height, pixels };
}

self.onmessage = async ({ data }) => {
  if (data?.type !== 'estimate') return;
  try {
    report('Starting local AI engine…', 'starting');
    const { pipeline, env } = await import('@huggingface/transformers');
    env.allowRemoteModels = true;
    // Avoid WebGPU driver stalls and WASM threading requirements on GitHub Pages.
    env.backends.onnx.wasm.numThreads = 1;
    report('Initializing compatible CPU depth engine…', 'loading');
    const estimator = await pipeline('depth-estimation', MODEL_ID, {
      device: 'wasm',
      dtype: 'q8',
      progress_callback: (event) => {
        if (event.status === 'progress') {
          report('Downloading the depth model…', 'downloading', event.progress);
        } else if (event.status === 'initiate' || event.status === 'download') {
          report('Loading model weights…', 'downloading');
        } else if (event.status === 'ready') {
          report('Depth model ready', 'loading');
        }
      },
    });
    report('Estimating foreground and background…', 'estimating');
    const prediction = await estimator(data.imageURL);
    const { width, height, pixels } = toGrayscale(prediction);
    self.postMessage({ type: 'result', width, height, grayscale: pixels.buffer }, [pixels.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error?.message || String(error) });
  }
};
