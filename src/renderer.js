import * as THREE from 'three';

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const lowMemoryDevice = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && Math.min(innerWidth, innerHeight) < 1100);

export class DepthRenderer {
  constructor(mount, onAngle) {
    this.mount = mount;
    this.onAngle = onAngle;
    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: !lowMemoryDevice,
      preserveDrawingBuffer: true,
      powerPreference: lowMemoryDevice ? 'low-power' : 'high-performance',
    });
    this.renderer.setPixelRatio(lowMemoryDevice ? 1 : Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x101820, 0);
    this.renderer.domElement.setAttribute('aria-label', 'Drag to tilt the image in 3D');
    this.renderer.domElement.style.touchAction = 'none';
    mount.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(36, 1, .1, 100);
    this.mesh = null;
    this.frame = null;
    this.depthPixels = null;
    this.depthWidth = 1;
    this.depthHeight = 1;
    this.meshWidth = 5;
    this.meshHeight = 4;
    this.settings = { strength: .70, motion: .65, zoom: 1, auto: true, smooth: .08 };
    this.pointer = { x: 0, y: 0 };
    this.smoothed = { x: 0, y: 0 };
    this.lastInteraction = 0;
    this.dragging = false;
    this.recordingMotion = false;
    this.recordingStart = 0;
    this.clockStart = performance.now();
    this.baseDistance = 8;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(mount);
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.mount.classList.add('dragging');
      canvas.setPointerCapture(e.pointerId);
      this.setPointerFromEvent(e);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'touch' || this.dragging) this.setPointerFromEvent(e);
    });
    const release = () => { this.dragging = false; this.mount.classList.remove('dragging'); };
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('pointerleave', () => { if (!this.dragging) this.lastInteraction = performance.now() - 2000; });
    this.resize();
    this.animate = this.animate.bind(this);
    this.animationFrame = requestAnimationFrame(this.animate);
  }

  setPointerFromEvent(e) {
    const rect = this.mount.getBoundingClientRect();
    this.pointer.x = clamp((e.clientX - rect.left) / rect.width * 2 - 1, -1, 1);
    this.pointer.y = clamp(1 - (e.clientY - rect.top) / rect.height * 2, -1, 1);
    this.lastInteraction = performance.now();
  }

  resize() {
    const w = Math.max(1, this.mount.clientWidth);
    const h = Math.max(1, this.mount.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.fitCamera();
  }

  fitCamera() {
    const half = (this.camera.fov * Math.PI / 180) / 2;
    this.baseDistance = Math.max(this.meshHeight, this.meshWidth / this.camera.aspect) / (2 * Math.tan(half)) * 1.18;
    this.camera.position.z = this.baseDistance / this.settings.zoom;
    this.camera.lookAt(0, 0, 0);
  }

  setScene(imageCanvas, depthCanvas) {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh.material.map.dispose();
      this.mesh.material.dispose();
      this.mesh = null;
    }
    if (this.frame) {
      this.scene.remove(this.frame);
      this.frame.geometry.dispose();
      this.frame.material.dispose();
    }
    const aspect = imageCanvas.width / imageCanvas.height;
    this.meshHeight = 4;
    this.meshWidth = 4 * aspect;
    const maxSeg = lowMemoryDevice ? 112 : 210;
    const minSeg = lowMemoryDevice ? 42 : 90;
    const targetSeg = lowMemoryDevice ? 80 : 155;
    const segX = Math.max(minSeg, Math.min(maxSeg, Math.round(targetSeg * Math.sqrt(aspect))));
    const segY = Math.max(minSeg, Math.min(maxSeg, Math.round(targetSeg / Math.sqrt(aspect))));
    const geometry = new THREE.PlaneGeometry(this.meshWidth, this.meshHeight, segX, segY);
    const imageTexture = new THREE.CanvasTexture(imageCanvas);
    imageTexture.colorSpace = THREE.SRGBColorSpace;
    imageTexture.anisotropy = lowMemoryDevice ? 1 : Math.min(this.renderer.capabilities.getMaxAnisotropy(), 8);
    const material = new THREE.MeshBasicMaterial({ map: imageTexture, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(geometry, material);
    this.scene.add(this.mesh);
    const frameGeometry = new THREE.PlaneGeometry(this.meshWidth + .07, this.meshHeight + .07);
    const frameMaterial = new THREE.MeshBasicMaterial({ color: 0x9aa69c, side: THREE.DoubleSide });
    this.frame = new THREE.Mesh(frameGeometry, frameMaterial);
    this.frame.position.z = -.075;
    this.scene.add(this.frame);
    this.setDepth(depthCanvas);
    this.fitCamera();
  }

  setDepth(depthCanvas) {
    const ctx = depthCanvas.getContext('2d', { willReadFrequently: true });
    this.depthPixels = ctx.getImageData(0, 0, depthCanvas.width, depthCanvas.height).data;
    this.depthWidth = depthCanvas.width;
    this.depthHeight = depthCanvas.height;
    this.updateDepth();
  }

  sampleDepth(u, v) {
    const x = clamp(u, 0, 1) * (this.depthWidth - 1);
    const y = clamp(1 - v, 0, 1) * (this.depthHeight - 1);
    const x0 = Math.floor(x), x1 = Math.min(this.depthWidth - 1, x0 + 1);
    const y0 = Math.floor(y), y1 = Math.min(this.depthHeight - 1, y0 + 1);
    const dx = x - x0, dy = y - y0;
    const p = this.depthPixels, w = this.depthWidth;
    const a = p[(y0 * w + x0) * 4];
    const b = p[(y0 * w + x1) * 4];
    const c = p[(y1 * w + x0) * 4];
    const d = p[(y1 * w + x1) * 4];
    return ((a * (1 - dx) + b * dx) * (1 - dy) + (c * (1 - dx) + d * dx) * dy) / 255;
  }

  updateDepth() {
    if (!this.mesh || !this.depthPixels) return;
    const positions = this.mesh.geometry.getAttribute('position');
    const uv = this.mesh.geometry.getAttribute('uv');
    const amount = this.settings.strength * .78;
    for (let i = 0; i < positions.count; i += 1) {
      const depth = this.sampleDepth(uv.getX(i), uv.getY(i));
      positions.setZ(i, amount * (depth - .42));
    }
    positions.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.mesh.geometry.computeBoundingSphere();
  }

  setSettings(settings) {
    const previousStrength = this.settings.strength;
    this.settings = { ...this.settings, ...settings };
    if (previousStrength !== this.settings.strength) this.updateDepth();
    this.fitCamera();
  }

  startRecordingMotion() {
    this.recordingMotion = true;
    this.recordingStart = performance.now();
  }
  stopRecordingMotion() { this.recordingMotion = false; }
  recenter() { this.pointer = { x: 0, y: 0 }; this.lastInteraction = performance.now(); }

  animate(time) {
    this.animationFrame = requestAnimationFrame(this.animate);
    if (document.hidden || this.mount.hidden || !this.mount.isConnected) return;
    if (this.mesh) {
      const sinceInteraction = time - this.lastInteraction;
      let targetX = this.pointer.x;
      let targetY = this.pointer.y;
      if (this.recordingMotion || (this.settings.auto && sinceInteraction > 4500)) {
        const t = this.recordingMotion ? (time - this.recordingStart) / 1000 : (time - this.clockStart) / 1000;
        const period = this.recordingMotion ? 4 : 9;
        targetX = Math.sin(2 * Math.PI * t / period) * .8;
        targetY = Math.cos(2 * Math.PI * t / period) * .48;
      }
      const smooth = this.recordingMotion ? .21 : this.settings.smooth;
      this.smoothed.x += (targetX - this.smoothed.x) * smooth;
      this.smoothed.y += (targetY - this.smoothed.y) * smooth;
      const m = this.settings.motion;
      this.mesh.rotation.y = -this.smoothed.x * m * .16;
      this.mesh.rotation.x = this.smoothed.y * m * .115;
      this.camera.position.x = this.smoothed.x * m * .36;
      this.camera.position.y = this.smoothed.y * m * .22;
      this.camera.position.z = this.baseDistance / this.settings.zoom;
      this.camera.lookAt(0, 0, 0);
      if (this.onAngle) this.onAngle(this.smoothed.x * m * 13, this.smoothed.y * m * 9);
    }
    this.renderer.render(this.scene, this.camera);
  }

  exportPng() { return this.renderer.domElement.toDataURL('image/png'); }
  canvas() { return this.renderer.domElement; }
  destroy() {
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver.disconnect();
    this.renderer.dispose();
  }
}