import { ACESFilmicToneMapping, Color, FogExp2, PCFSoftShadowMap, PerspectiveCamera, PostProcessing, Raycaster, Scene, Vector2, Vector3 } from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { beginFrame, createRenderer } from '../gpu/renderer.js';
import { Sky } from './sky.js';
import { perf } from '../perf/stats.js';
import { rememberMotion, storedMotion } from './motion.js';

/** Calm motion: decoration (particles, pulsing halo) stops this long after the last input, to save battery. */
const AMBIENT_TIMEOUT = 20000;
/** Calm motion: decoration-only frames run at most this often (ms), ~30 fps. */
const AMBIENT_INTERVAL = 33;
/** Node bloom vs UnrealBloomPass: see setBloom(). */
const BLOOM_STRENGTH = 1.15;
const BLOOM_RADIUS = 0.4;

/**
 * Renderer, camera, controls and bloom shared by every view. Frames are drawn when something changed
 * (invalidate), while the camera moves or flies, and while a view says it is animating. Decoration (the
 * twinkling sky, flowing links, breathing glow) follows the motion setting: every frame ("living"), at
 * 30 fps until the user is away ("calm"), or never ("off") – then an idle map draws nothing.
 */
export class Stage {
  constructor(container) {
    this.container = container;
    // The canvas exists at once (controls and input bind to it); the renderer behind it starts asynchronously.
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'stage-canvas';
    container.appendChild(this.canvas);
    this.renderer = null;
    this.backend = null; // 'webgpu' | 'webgl' once ready

    this.scene = new Scene();
    this.scene.background = new Color('#04060c');
    this.camera = new PerspectiveCamera(55, 1, 0.5, 40000);
    this.camera.position.set(0, 120, 420);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.rotateSpeed = 0.6;
    this.controls.zoomSpeed = 1.1;
    this.controls.screenSpacePanning = true;
    this.bloomSettings = { strength: 0.9, radius: 0.55, threshold: 0.18 };

    this.raycaster = new Raycaster();
    this.pointer = new Vector2();
    this.listeners = new Set();
    this.flight = null;
    this.lastTime = performance.now();
    this.sky = new Sky();
    this.scene.add(this.sky.group);

    this.raf = 0;
    this.ambientTimer = 0;
    this.dirty = true;
    this.trailingFrames = 0;
    this.lastInput = performance.now();
    this.ambientSleeping = false;
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    this.motionChoice = storedMotion();
    this.controls.addEventListener('change', () => this.invalidate());
    const input = () => this.onInput();
    for (const type of ['pointerdown', 'pointermove', 'wheel']) this.canvas.addEventListener(type, input, { passive: true });
    window.addEventListener('keydown', input);
    document.addEventListener('visibilitychange', () => document.hidden || this.invalidate());

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    /** Resolves once the GPU is ready (WebGPU, or WebGL 2 where WebGPU is missing); rejects if neither works. */
    this.ready = this.start();
  }

  async start() {
    const { renderer, backend, adapter, software } = await createRenderer({ canvas: this.canvas });
    this.renderer = renderer;
    this.backend = backend;
    this.adapter = adapter;
    this.software = software;
    // Software rendering (no GPU): fewer pixels and no multisampling keep it usable.
    renderer.setPixelRatio(software ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
    renderer.onDeviceLost = (info) => this.onDeviceLost?.(info);

    // The scene in an HDR, multisampled target; bloom on top; tone mapping and sRGB at the end.
    this.post = new PostProcessing(renderer);
    const scenePass = pass(this.scene, this.camera, { samples: software ? 0 : 4 });
    const color = scenePass.getTextureNode('output');
    this.bloom = bloom(color);
    this.post.outputNode = color.add(this.bloom);
    const { strength, radius, threshold } = this.bloomSettings;
    this.setBloom(strength, radius, threshold);
    this.resize();
    this.invalidate();
    return this;
  }

  onFrame(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer?.setSize(w, h);
    this.width = w;
    this.height = h;
    this.invalidate();
  }

  /**
   * Bloom in the units the views were tuned with (UnrealBloomPass). The node bloom blurs each level more
   * narrowly, so a larger radius (more weight on the wide levels) gives the same soft haze.
   */
  setBloom(strength, radius = 0.55, threshold = 0.18) {
    this.bloomSettings = { strength, radius, threshold };
    if (this.bloom) {
      this.bloom.strength.value = strength * BLOOM_STRENGTH;
      this.bloom.radius.value = Math.min(1, radius + BLOOM_RADIUS);
      this.bloom.threshold.value = threshold;
    }

    this.invalidate();
  }

  /** Background colour, fog, the starry sky and how strong its nebulae are (0..1). */
  setAtmosphere({ background = '#04060c', fog = 0, stars = true, nebula = 1 } = {}) {
    this.scene.background = new Color(background);
    this.scene.fog = fog > 0 ? new FogExp2(background, fog) : null;
    this.sky.set({ stars, nebula });
    this.invalidate();
  }

  /** Stops drawing (e.g. while a full-screen panel covers the map) to save GPU and battery. */
  setPaused(paused) {
    this.paused = paused;
    this.lastTime = performance.now();
    if (!paused) this.invalidate();
  }

  /** Something on screen changed: draw a frame (at most one per display refresh). */
  invalidate() {
    this.dirty = true;
    this.requestFrame();
  }

  requestFrame() {
    if (this.raf || this.paused || !this.renderer) return;
    clearTimeout(this.ambientTimer);
    this.ambientTimer = 0;
    this.raf = requestAnimationFrame((now) => this.frame(now));
  }

  /**
   * The motion setting in effect: the user's choice, else "living" – or "calm" without a GPU (software
   * frames are expensive) and when the system asks for less motion.
   */
  get motion() {
    return this.motionChoice ?? (this.software || this.reducedMotion?.matches ? 'calm' : 'living');
  }

  /** Sets (and remembers) the motion: 'living' | 'calm' | 'off', or null for the automatic choice. */
  setMotion(value) {
    this.motionChoice = value ?? null;
    rememberMotion(value);
    this.ambientSleeping = false;
    this.invalidate();
  }

  /** Pointer, wheel or keyboard: ambient motion wakes up again. */
  onInput() {
    this.lastInput = performance.now();
    if (this.ambientSleeping) {
      this.ambientSleeping = false;
      this.requestFrame();
    }
  }

  /** Calm motion: decoration runs while the user is around. */
  ambientAllowed(now) {
    return !document.hidden && now - this.lastInput < AMBIENT_TIMEOUT;
  }

  /**
   * One frame. Listeners (the active view) return true while something moves (layout, animation), or
   * 'ambient' for decorative motion that may slow down and stop when the user is away.
   */
  frame() {
    this.raf = 0;
    if (this.paused) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    const flying = !!this.flight;
    this.updateFlight(now);
    // OrbitControls reports a change while damping (and auto-rotating); its 'change' event also invalidates.
    let busy = this.controls.update() || flying;
    let ambient = false;
    const draw = this.dirty;
    this.dirty = false;
    for (const fn of this.listeners) {
      const result = fn(dt, now);
      if (result === 'ambient') ambient = true;
      else if (result) busy = true;
    }

    // The twinkling sky is decoration too: with "living" motion the map never stands still.
    if (this.sky.visible && this.motion === 'living') ambient = true;

    // three's node renderer applies some per-frame updates (instance colours and matrices it copied) one
    // frame late, so every change is followed by one more frame.
    const trailing = this.trailingFrames > 0;
    const render = draw || busy || ambient || trailing || this.dirty;
    if (render) {
      this.sky.update(dt);
      beginFrame(this.renderer);
      this.post.render();
    }

    perf.frame(now, performance.now() - now, render);
    if (draw || busy) this.trailingFrames = 1;
    else if (trailing) this.trailingFrames--;
    const motion = this.motion;
    if (busy || this.dirty || this.trailingFrames > 0 || (ambient && motion === 'living')) this.requestFrame();
    else if (ambient && motion === 'calm') {
      if (this.ambientAllowed(now)) this.ambientTimer = setTimeout(() => this.requestFrame(), AMBIENT_INTERVAL);
      else this.ambientSleeping = true;
    }
  }

  /** Smoothly moves the camera so that it looks at `target` from `position`. */
  flyTo(target, position, duration = 900) {
    this.flight = {
      start: performance.now(),
      duration,
      fromTarget: this.controls.target.clone(),
      toTarget: target.clone(),
      fromPos: this.camera.position.clone(),
      toPos: position.clone(),
    };
    this.invalidate();
  }

  /** Puts the camera there at once. */
  jumpTo(target, position) {
    this.flight = null;
    this.controls.target.copy(target);
    this.camera.position.copy(position);
    this.invalidate();
  }

  /** Flies to a point keeping the current viewing direction, at the given distance. */
  focusOn(target, distance, duration = 900) {
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0.3, 1);
    dir.normalize().multiplyScalar(distance);
    this.flyTo(target, target.clone().add(dir), duration);
  }

  updateFlight(now) {
    const f = this.flight;
    if (!f) return;
    const t = Math.min(1, (now - f.start) / f.duration);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    this.controls.target.lerpVectors(f.fromTarget, f.toTarget, e);
    this.camera.position.lerpVectors(f.fromPos, f.toPos, e);
    if (t >= 1) this.flight = null;
  }

  /** Converts a DOM event into a ray and intersects the given objects. */
  pick(event, objects) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.intersectObjects(objects, false);
  }

  /** Projects a world position to CSS pixels; returns null when behind the camera. */
  project(position, out = new Vector3()) {
    out.copy(position).project(this.camera);
    if (out.z > 1 || out.z < -1) return null;
    return { x: (out.x * 0.5 + 0.5) * this.width, y: (-out.y * 0.5 + 0.5) * this.height, depth: out.z };
  }
}
