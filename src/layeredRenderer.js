import * as THREE from 'three';

const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const MOBILE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
  (navigator.maxTouchPoints > 1 && Math.min(window.innerWidth, window.innerHeight) < 1100);

/**
 * A set of alpha-masked image planes. Each plane represents a portion of
 * relative scene depth. The background is hole-filled before parallax motion,
 * reducing the double-image artifacts of a simple, duplicated background.
 */
export class LayeredDepthRenderer {
  constructor(mount, onAngle = () => {}) {
    this.mount = mount;
    this.onAngle = onAngle;
    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: !MOBILE,
      preserveDrawingBuffer: true,
      powerPreference: MOBILE ? 'low-power' : 'high-performance',
    });
    this.renderer.setPixelRatio(MOBILE ? 1 : Math.min(2, devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x101820, 0);
    const surface = this.renderer.domElement;
    surface.style.touchAction = 'none';
    surface.setAttribute('aria-label', 'Drag to shift the foreground and background independently');
    mount.appendChild(surface);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.layers = [];
    this.meshWidth = 5;
    this.meshHeight = 4;
    this.baseDistance = 8;
    this.settings = { strength: .95, motion: .82, auto: true, zoom: 1, smooth: .11 };
    this.pointer = { x: 0, y: 0 };
    this.smoothed = { x: 0, y: 0 };
    this.lastInteraction = performance.now();
    this.recordingMotion = false;
    this.recordingStart = 0;
    this.clockStart = performance.now();
    this.dragging = false;
    this.visible = true;
    this.lastFrameTime = 0;

    surface.addEventListener('pointerdown', (event) => {
      this.dragging = true;
      mount.classList.add('dragging');
      surface.setPointerCapture(event.pointerId);
      this.trackPointer(event);
    });
    surface.addEventListener('pointermove', (event) => {
      if (event.pointerType !== 'touch' || this.dragging) this.trackPointer(event);
    });
    const release = () => { this.dragging = false; mount.classList.remove('dragging'); };
    surface.addEventListener('pointerup', release);
    surface.addEventListener('pointercancel', release);
    surface.addEventListener('pointerleave', () => {
      if (!this.dragging) this.lastInteraction = performance.now();
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(mount);
    this.resize();
    this.animate = this.animate.bind(this);
    this.animationFrame = requestAnimationFrame(this.animate);
  }

  trackPointer(event) {
    const rect = this.mount.getBoundingClientRect();
    this.pointer.x = clamp(2 * (event.clientX - rect.left) / Math.max(1, rect.width) - 1, -1, 1);
    this.pointer.y = clamp(1 - 2 * (event.clientY - rect.top) / Math.max(1, rect.height), -1, 1);
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
    const angle = this.camera.fov * Math.PI / 360;
    const fitDistance = Math.max(
      this.meshHeight,
      this.meshWidth / Math.max(.1, this.camera.aspect)
    ) / (2 * Math.tan(angle));
    this.baseDistance = fitDistance * (MOBILE ? 1.09 : 1.12);
    this.camera.position.z = this.baseDistance / this.settings.zoom;
    this.camera.lookAt(0, 0, 0);
    // Compensate for layer distance so all bands align at the neutral viewpoint.
    for (const layer of this.layers) {
      const compensation = (this.baseDistance - layer.z) / this.baseDistance;
      layer.mesh.scale.setScalar(compensation * layer.baseScale);
    }
  }

  clearLayers() {
    for (const layer of this.layers) {
      this.group.remove(layer.mesh);
      layer.mesh.geometry.dispose();
      layer.mesh.material.map?.dispose();
      layer.mesh.material.dispose();
    }
    this.layers.length = 0;
  }

  setScene(pack) {
    if (!pack?.layers?.length) throw new Error('The layered scene has no layers.');
    this.clearLayers();
    this.meshHeight = 4;
    this.meshWidth = 4 * pack.width / pack.height;
    for (let i = 0; i < pack.layers.length; i++) {
      const entry = pack.layers[i];
      const texture = new THREE.CanvasTexture(entry.canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = MOBILE ? 1 : 2;
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        transparent: i > 0,
        opacity: 1,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const geometry = new THREE.PlaneGeometry(this.meshWidth, this.meshHeight);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.z = entry.z;
      mesh.renderOrder = i;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.layers.push({
        mesh,
        z: entry.z,
        parallax: entry.parallax,
        baseScale: entry.scale || 1,
      });
    }
    this.fitCamera();
  }

  // Kept for compatibility with older controls and callers.
  setDepth() {}

  setSettings(settings) {
    this.settings = { ...this.settings, ...settings };
    this.fitCamera();
  }

  recenter() {
    this.pointer.x = 0;
    this.pointer.y = 0;
    this.lastInteraction = performance.now();
  }

  startRecordingMotion() {
    this.recordingMotion = true;
    this.recordingStart = performance.now();
  }

  stopRecordingMotion() { this.recordingMotion = false; }

  animate(now) {
    this.animationFrame = requestAnimationFrame(this.animate);
    if (document.hidden || this.mount.hidden || !this.mount.isConnected) return;
    if (MOBILE && !this.dragging && !this.recordingMotion && now - this.lastFrameTime < 33) return;
    this.lastFrameTime = now;

    const elapsed = now - this.lastInteraction;
    let x = this.pointer.x;
    let y = this.pointer.y;
    if (this.recordingMotion || (this.settings.auto && elapsed > 2200)) {
      const t = this.recordingMotion ?
        (now - this.recordingStart) / 1000 : (now - this.clockStart) / 1000;
      const period = this.recordingMotion ? 4 : 7;
      x = Math.sin(2 * Math.PI * t / period) * .84;
      y = Math.cos(2 * Math.PI * t / period) * .46;
    }
    const smooth = this.recordingMotion ? .20 : this.settings.smooth;
    this.smoothed.x += (x - this.smoothed.x) * smooth;
    this.smoothed.y += (y - this.smoothed.y) * smooth;

    const motion = this.settings.motion;
    const strength = this.settings.strength;
    // All layers share the same neutral alignment, with different camera responses.
    // Moving toward the viewer increases differential parallax.
    for (const layer of this.layers) {
      const p = layer.parallax;
      layer.mesh.position.x = this.smoothed.x * motion * strength * p * .34;
      layer.mesh.position.y = this.smoothed.y * motion * strength * p * .21;
      layer.mesh.rotation.y = -this.smoothed.x * motion * strength * p * .036;
      layer.mesh.rotation.x = this.smoothed.y * motion * strength * p * .024;
    }
    this.camera.position.x = this.smoothed.x * motion * .19;
    this.camera.position.y = this.smoothed.y * motion * .12;
    this.camera.position.z = this.baseDistance / this.settings.zoom;
    this.camera.lookAt(0, 0, 0);
    this.onAngle(this.smoothed.x * motion * 14, this.smoothed.y * motion * 10);
    this.renderer.render(this.scene, this.camera);
  }

  exportPng() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  canvas() { return this.renderer.domElement; }

  destroy() {
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver.disconnect();
    this.clearLayers();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
