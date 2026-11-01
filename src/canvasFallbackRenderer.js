// Minimal 2D photo preview when WebGL is unavailable. This does not claim real 3D displacement.
export class CanvasFallbackRenderer {
  constructor(mount, onAngle) {
    this.mount = mount;
    this.onAngle = onAngle;
    this.element = document.createElement('canvas');
    this.element.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';
    this.ctx = this.element.getContext('2d', { alpha: false });
    if (!this.ctx) throw new Error('2D canvas unavailable.');
    mount.append(this.element);
    this.photo = null;
    this.settings = { motion: .65, auto: true };
    this.pointer = { x: 0, y: 0 };
    this.recording = false;
    this.recordStart = 0;
    this.clockStart = performance.now();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(mount);
    this.element.addEventListener('pointerdown', e => {
      if (this.element.setPointerCapture) this.element.setPointerCapture(e.pointerId);
      this.setPointer(e);
    });
    this.element.addEventListener('pointermove', e => {
      if (e.pointerType !== 'touch' || e.buttons) this.setPointer(e);
    });
    this.element.addEventListener('pointerup', e => {
      if (this.element.hasPointerCapture?.(e.pointerId)) this.element.releasePointerCapture(e.pointerId);
    });
    this.resize();
    this.animate = this.animate.bind(this);
    this.frame = requestAnimationFrame(this.animate);
  }
  setPointer(e) {
    const rect = this.element.getBoundingClientRect();
    this.pointer = {
      x: Math.max(-1, Math.min(1, 2 * (e.clientX - rect.left) / Math.max(1, rect.width) - 1)),
      y: Math.max(-1, Math.min(1, 2 * (e.clientY - rect.top) / Math.max(1, rect.height) - 1))
    };
  }
  resize() {
    this.element.width = Math.min(1024, Math.max(1, this.mount.clientWidth));
    this.element.height = Math.min(1024, Math.max(1, this.mount.clientHeight));
    this.draw();
  }
  setScene(photo) { this.photo = photo; this.draw(); }
  setDepth() { this.draw(); }
  setSettings(settings) { this.settings = { ...this.settings, ...settings }; }
  recenter() { this.pointer = { x: 0, y: 0 }; }
  startRecordingMotion() { this.recording = true; this.recordStart = performance.now(); }
  stopRecordingMotion() { this.recording = false; }
  draw(time = 0) {
    const w = this.element.width, h = this.element.height;
    this.ctx.fillStyle = '#101820';
    this.ctx.fillRect(0, 0, w, h);
    if (!this.photo) return;
    const ratio = Math.min(w / this.photo.width, h / this.photo.height);
    const iw = this.photo.width * ratio, ih = this.photo.height * ratio;
    const auto = this.recording || this.settings.auto;
    const elapsed = this.recording ? time - this.recordStart : time - this.clockStart;
    const motion = this.settings.motion || 0;
    const x = Math.max(-1, Math.min(1, this.pointer.x + (auto ? Math.sin(elapsed / 1650) * .3 : 0)));
    const y = this.pointer.y;
    this.ctx.drawImage(this.photo, (w - iw) / 2 + x * motion * 6,
      (h - ih) / 2 + y * motion * 5, iw, ih);
    this.onAngle(x * motion * 5, y * motion * 5);
  }
  animate(time) {
    this.frame = requestAnimationFrame(this.animate);
    if (!document.hidden && !this.mount.hidden && this.mount.isConnected) this.draw(time);
  }
  exportPng() { this.draw(performance.now()); return this.element.toDataURL('image/png'); }
  canvas() { return this.element; }
  destroy() {
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.element.remove();
  }
}
