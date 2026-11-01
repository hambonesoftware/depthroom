# Depthroom — AI photo to 2.5D studio

A polished, **privacy-first static website** that turns a user-supplied photograph into an interactive **2.5D parallax scene**. Designed to deploy on GitHub Pages without a backend, API keys, or account system.

## What it does

1. Upload or drag in a JPG, PNG, WebP, or HEIC/HEIF photo.
2. Download the on-device **Depth Anything V2 Small** AI model on first use (model artifacts are fetched from Hugging Face).
3. Predict a monocular depth map, build a depth-displaced Three.js plane, and tilt the perspective using a mouse or touch.
4. Adjust depth strength, camera motion, smoothing, contrast, and depth inversion; select Natural, Cinematic, or Dreamy presets.
5. Export a screenshot PNG, depth-map PNG, interactive `.html` file, or a short animated MP4/WebM where supported.

### Privacy

The uploaded image remains in the browser. Model inference runs locally using WebGPU (if available) or WebAssembly/CPU. There is **no image-upload API** and no backend. The model, JavaScript, and optional Google Fonts are fetched from their public hosts. Exported interactive HTML embeds photo and depth map, and loads the Three.js rendering library from a public CDN when opened; it does not upload the photo. Processing drops source EXIF/GPS metadata when copying the image into a canvas.

### Technical limitations

- This is **2.5D**, not a full reconstruction: it is a single textured displacement surface inferred from one photo. Large side angles may reveal distortions and stretched textures, particularly at silhouette edges. It does not create newly hidden geometry or fill occluded areas.
- The AI depth prediction estimates relative closeness, not physical distance in meters.
- A model download (potentially tens or hundreds of MB) is required the first time. Browser and connection limits affect speed; WebGPU will often be faster than CPU.
- If the model cannot load or run, the app uses an explicitly labeled simple geometric approximation so the user can still preview the effect.
- Video export uses `MediaRecorder`, which may be unavailable or browser-dependent. Interactive HTML export remains an alternative.
- Exported HTML requires internet access to load Three.js; the image and estimated depth map themselves are included inside the file.
- By default uploaded images are resized for performance to at most 1600 pixels on the long side.

## Develop locally

Requires Node.js 20.19+ or 22.12+ (Node 22 recommended).

```sh
npm install
npm run dev
```

Open the URL printed by Vite (normally `http://localhost:5173`).

Build and preview the production version:

```sh
npm run build
npm run preview
```

## Publish to GitHub Pages

1. Create an **empty public repository** on GitHub, for example `depthroom`. Do **not** initialize it with a README.
2. Unzip these source files into that repository (including the hidden `.github/workflows/deploy.yml` folder), commit, and push to `main`.
3. In the repository, open **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. Open **Actions** to follow the included Pages deployment workflow. It runs `npm install`, `npm run build`, and publishes `dist`.
5. Your site will be at `https://YOUR-USERNAME.github.io/depthroom/` (assuming the repository is named `depthroom`).

Suggested first-time terminal commands from inside the unzipped project:

```sh
git init
git branch -M main
git add .
git commit -m "Build Depthroom 2.5D photo studio"
git remote add origin https://github.com/YOUR-USERNAME/depthroom.git
git push -u origin main
```

**Important:** GitHub Pages does not execute backend Python. This site intentionally runs the model and 3D display in the visitor's browser. The included `.github/workflows/deploy.yml` compiles the Vite app; do not use Pages' old “Deploy from a branch” option with raw source code.

## Project structure

- `index.html` — the complete accessible studio UI
- `src/style.css` — responsive visual design
- `src/main.js` — input, state, controls, exports, and status messages
- `src/depth.js` — image decoding, Depth Anything V2 inference, and map processing
- `src/renderer.js` — Three.js 2.5D geometry, camera, mouse/touch interaction
- `src/exportScene.js` — exports an interactive HTML scene with embedded photo/depth
- `.github/workflows/deploy.yml` — automatic GitHub Pages deployment

## Credits / technology

- [Depth Anything V2](https://huggingface.co/onnx-community/depth-anything-v2-small) via [Transformers.js](https://huggingface.co/docs/transformers.js/index)
- [Three.js](https://threejs.org/) for the interactive depth mesh
- [Vite](https://vite.dev/) for local development and static-site builds
- [heic2any](https://github.com/alexcorvi/heic2any) for HEIC support where the browser cannot decode it natively

Licenses for dependencies and model weights are governed by their respective upstream projects. Verify those terms before commercial distribution.