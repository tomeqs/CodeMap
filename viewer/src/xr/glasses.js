import { Spherical, Vector3 } from 'three';
import { fmt, h } from '../ui/dom.js';

/**
 * AR glasses that take side-by-side stereo over USB-C (XREAL One / One Pro and similar): the computer sees
 * them as a display, and with the glasses' 3D mode on, the left half of a 3840×1080 picture goes to the left
 * eye and the right half to the right eye (half SBS: 1920×1080, each eye squeezed). Black is see-through,
 * so the map floats in the room. Head tracking is the glasses' own (their 3DoF anchor), not ours.
 *
 * The session switches the stage to stereo, hides the normal UI (it would be split between the eyes), draws
 * a small HUD once per eye, and replaces the mouse pointer (one eye only) with a reticle in the middle of
 * the view: what is under it is hovered, a click or Space selects it.
 */

/** Diagonal field of view per eye (degrees). */
export const PROFILES = {
  'xreal-one-pro': { name: 'XREAL One Pro', fov: 57 },
  'xreal-one': { name: 'XREAL One', fov: 50 },
  other: { name: 'Other side-by-side glasses', fov: 46 },
};

const DEFAULTS = { profile: 'xreal-one-pro', fov: 57, sbs: 'full', ipd: 63, distance: 1.8, size: 1.2, convergence: 4, stars: false };
const KEY = 'codemap.ar';
/** How often the reticle looks for what is under it (ms). */
const HOVER_INTERVAL = 100;

/** Vertical field of view (degrees) of a 16:9 eye with this diagonal field of view. */
export function verticalFov(diagonal) {
  const t = Math.tan((diagonal * Math.PI) / 360);
  return (2 * Math.atan((t * 9) / Math.hypot(16, 9)) * 180) / Math.PI;
}

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // not remembered; still used now
  }
}

export class GlassesSession {
  constructor(app) {
    this.app = app;
    this.active = false;
    this.settings = loadSettings();
    this.screen = null; // the glasses' screen, if the browser can tell (Window Management API)
    this.hovered = null;
    this.lastHover = 0;
    this.onKey = (e) => this.key(e);
    this.onFullscreen = () => {
      if (this.active && this.fullscreen && !document.fullscreenElement) this.exit();
    };
  }

  /** Stage options for the current settings. */
  stereoOptions() {
    const s = this.settings;
    return { sbs: s.sbs, fovY: verticalFov(s.fov), ipd: s.ipd / 1000, convergence: s.convergence, stars: s.stars, distance: s.distance, size: s.size };
  }

  // ------------------------------------------------------------------ start panel

  /** The panel on the computer's screen: how to set the glasses up, the settings, Start. */
  openPanel() {
    if (this.app.hostIsEditor) {
      this.app.toast('AR glasses need the browser: open the map with `codemap ui` or as an HTML file, then press AR.');
      return;
    }

    document.getElementById('ar-panel')?.remove();
    const s = this.settings;
    const set = (key, value) => {
      s[key] = value;
      saveSettings(s);
    };
    const number = (key, step, min, max) =>
      h('input', { type: 'number', value: s[key], step, min, max, onChange: (e) => set(key, Number(e.target.value) || DEFAULTS[key]) });
    const fovInput = number('fov', 1, 20, 120);
    const screenNote = h('span', { class: 'small faint' }, this.screen ? this.screenName(this.screen) : '');
    const panel = h('div', { id: 'ar-panel', onClick: (e) => e.target === panel && panel.remove() },
      h('div', { class: 'ar-dialog' },
        h('h2', {}, 'View in AR glasses'),
        h('ol', {},
          h('li', {}, 'Connect the glasses to this computer (USB-C) and use them as an extended display.'),
          h('li', {}, 'On the glasses: double-click the X button → Spatial Screen → 3D Mode → Full SBS. The display becomes 3840×1080.'),
          h('li', {}, 'Optional: set the screen to Anchor to keep the map in place as you turn your head.'),
          h('li', {}, 'Press Start. Rotate with the mouse or arrow keys; look at a node through the ring and click (or Space) to select it; Esc goes back.'),
        ),
        h('div', { class: 'row' }, h('label', {}, 'Glasses'),
          h('select', { onChange: (e) => {
            set('profile', e.target.value);
            set('fov', PROFILES[e.target.value].fov);
            fovInput.value = s.fov;
          } }, Object.entries(PROFILES).map(([key, p]) => h('option', { value: key, selected: key === s.profile }, p.name)))),
        h('div', { class: 'row' }, h('label', {}, 'Field of view (diagonal, °)'), fovInput),
        h('div', { class: 'row' }, h('label', {}, '3D mode on the glasses'),
          h('select', { onChange: (e) => set('sbs', e.target.value) },
            h('option', { value: 'full', selected: s.sbs === 'full' }, 'Full SBS (3840×1080)'),
            h('option', { value: 'half', selected: s.sbs === 'half' }, 'Half SBS (1920×1080)'))),
        h('div', { class: 'row' }, h('label', {}, 'Distance to the map (m)'), number('distance', 0.1, 0.5, 10)),
        h('div', { class: 'row' }, h('label', {}, 'Map size (m)'), number('size', 0.1, 0.2, 10)),
        h('div', { class: 'row' }, h('label', {}, 'Eye distance, IPD (mm)'), number('ipd', 1, 50, 80)),
        h('div', { class: 'row', title: 'Where both eyes see the same picture: the glasses’ screen plane. Lower it if the map looks doubled.' },
          h('label', {}, 'Screen plane (m)'), number('convergence', 0.1, 0.5, 20)),
        h('label', { class: 'row' }, h('span', {}, 'Stars behind the map'), h('input', { type: 'checkbox', checked: s.stars, onChange: (e) => set('stars', e.target.checked) })),
        'getScreenDetails' in window
          ? h('div', { class: 'row' }, h('button', { onClick: async () => {
            this.screen = await findGlassesScreen();
            screenNote.textContent = this.screen ? this.screenName(this.screen) : 'No second screen found: drag this window onto the glasses, then Start.';
          } }, 'Find the glasses screen'), screenNote)
          : h('div', { class: 'note' }, 'This browser cannot pick a screen: drag this window onto the glasses before Start (Chrome or Edge can do it for you).'),
        h('div', { class: 'buttons' },
          h('button', { onClick: () => panel.remove() }, 'Cancel'),
          h('button', { class: 'primary', onClick: () => {
            panel.remove();
            this.start({ fullscreen: true });
          } }, 'Start')),
      ));
    document.getElementById('app').append(panel);
  }

  screenName(screen) {
    return `${screen.label || 'Second screen'} · ${screen.width}×${screen.height}`;
  }

  // ------------------------------------------------------------------ session

  /** Enters AR. fullscreen: on the glasses' screen when known (needs the click that called this). */
  async start({ fullscreen = true, sbs } = {}) {
    if (sbs) this.settings.sbs = sbs;
    if (fullscreen) {
      try {
        await document.documentElement.requestFullscreen(this.screen ? { screen: this.screen } : undefined);
        this.fullscreen = true;
      } catch {
        this.fullscreen = false; // still usable: the window may already fill the glasses
      }
    }

    this.enter();
  }

  enter() {
    const app = this.app;
    this.active = true;
    document.body.classList.add('ar-active');
    this.buildHud();
    app.stage.setStereo(this.stereoOptions());
    app.view?.fit(false);
    window.addEventListener('keydown', this.onKey, true);
    document.addEventListener('fullscreenchange', this.onFullscreen);
    this.stopFrames = app.stage.onFrame(() => this.frame());
    this.resizeObserver = new ResizeObserver(() => this.checkScreen());
    this.resizeObserver.observe(document.body);
    this.hint('Look at a node through the ring · click or Space: select · arrows: turn · + −: closer · [ ]: size · R: recentre · Esc: back', 7000);
    this.update();
  }

  exit() {
    if (!this.active) return;
    const app = this.app;
    this.active = false;
    window.removeEventListener('keydown', this.onKey, true);
    document.removeEventListener('fullscreenchange', this.onFullscreen);
    this.stopFrames?.();
    this.resizeObserver?.disconnect();
    this.hud?.remove();
    this.hud = null;
    document.body.classList.remove('ar-active');
    if (this.hovered) app.view?.setHovered?.(null);
    this.hovered = null;
    app.stage.setStereo(null);
    app.view?.fit(false);
    if (this.fullscreen && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.fullscreen = false;
  }

  /** Settings changed from the keyboard: remembered, and the stage follows. */
  apply() {
    saveSettings(this.settings);
    this.app.stage.setStereo(this.stereoOptions());
  }

  // ------------------------------------------------------------------ input

  key(e) {
    const app = this.app;
    const stage = app.stage;
    let handled = true;
    if (e.key === 'Escape') {
      if (app.selection) app.select(null);
      else this.exit();
    } else if (e.key === ' ' || e.key === 'Enter') this.selectAtReticle();
    else if (e.key.startsWith('Arrow')) {
      const step = 0.12;
      this.orbit(e.key === 'ArrowLeft' ? step : e.key === 'ArrowRight' ? -step : 0, e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0);
    } else if (e.key === '+' || e.key === '=') this.dolly(0.85);
    else if (e.key === '-' || e.key === '_') this.dolly(1 / 0.85);
    else if (e.key === '[' || e.key === ']') {
      this.settings.size = Math.min(10, Math.max(0.2, this.settings.size * (e.key === ']' ? 1.15 : 1 / 1.15)));
      this.apply();
      app.view?.fit(true);
      this.message(`Map size ${this.settings.size.toFixed(2)} m`, 1500);
    } else if (e.key === 'r' || e.key === 'R') app.view?.fit(true);
    else handled = false; // views, levels and the rest go to the app as usual
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
      stage.onInput();
      stage.invalidate();
    }
  }

  /** Turns the camera around its target (radians). */
  orbit(left, up) {
    const { camera, controls } = this.app.stage;
    const offset = camera.position.clone().sub(controls.target);
    const spherical = new Spherical().setFromVector3(offset);
    spherical.theta += left;
    spherical.phi = Math.min(Math.PI - 0.05, Math.max(0.05, spherical.phi - up));
    camera.position.copy(controls.target).add(new Vector3().setFromSpherical(spherical));
    camera.lookAt(controls.target);
  }

  /** Moves the camera towards (factor < 1) or away from its target. */
  dolly(factor) {
    const { camera, controls } = this.app.stage;
    camera.position.sub(controls.target).multiplyScalar(factor).add(controls.target);
  }

  /** What the reticle points at (a unit id), or null. */
  target() {
    return this.app.view?.pickAlong?.(this.app.stage.centerRay()) ?? null;
  }

  selectAtReticle() {
    const id = this.target();
    if (id) this.app.handleClickOn(id);
    else this.app.select(null);
  }

  drillAtReticle() {
    const id = this.target();
    if (id) this.app.drill(id);
  }

  /** Every frame: hover what is under the reticle (a few times a second), keep the HUD current. */
  frame() {
    const now = performance.now();
    if (now - this.lastHover < HOVER_INTERVAL) return false;
    this.lastHover = now;
    this.placeHud();
    const id = this.target();
    if (id !== this.hovered) {
      this.hovered = id;
      this.app.view?.setHovered?.(id);
      this.update();
    }

    return false;
  }

  // ------------------------------------------------------------------ HUD (once per eye)

  buildHud() {
    this.hud?.remove();
    const eye = (side) => h('div', { class: `ar-eye eye-${side}` }, h('div', { class: 'ar-eye-inner' }));
    this.hud = h('div', { id: 'ar-hud' }, eye('left'), eye('right'));
    document.getElementById('app').append(this.hud);
    this.texts = { hint: '', message: '' };
  }

  hint(text, ms) {
    this.texts.hint = text;
    this.update();
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => {
      this.texts.hint = '';
      this.update();
    }, ms);
  }

  /** A short message on both eyes (also what the app's toasts become in AR). */
  message(text, ms = 4000) {
    if (!this.hud) return;
    this.texts.message = text;
    this.update();
    clearTimeout(this.messageTimer);
    this.messageTimer = setTimeout(() => {
      this.texts.message = '';
      this.checkScreen();
    }, ms);
  }

  /** Not side by side? Say how to switch the glasses' 3D mode on. */
  checkScreen() {
    if (!this.active) return;
    const { width, height } = this.app.stage;
    const expected = this.settings.sbs === 'half' ? 16 / 9 : 32 / 9;
    const off = Math.abs(width / height / expected - 1) > 0.06;
    if (off && !this.texts.message) this.texts.message = this.settings.sbs === 'half'
      ? `This screen is ${width}×${height}. On the glasses: 3D Mode → Half SBS, with this window full screen on them.`
      : `This screen is ${width}×${height}, not 3840×1080. On the glasses: double-click X → Spatial Screen → 3D Mode → Full SBS.`;
    this.update();
  }

  update() {
    if (!this.hud) return;
    const app = this.app;
    const node = app.selection?.nodeId ? app.model?.get(app.selection.nodeId) : null;
    const hovered = !node && this.hovered ? app.model?.get(this.hovered) : null;
    const shown = node ?? hovered;
    const metrics = shown?.metrics ?? {};
    const parts = [
      metrics.loc !== undefined && `${fmt(metrics.loc)} LOC`,
      metrics.complexity !== undefined && `complexity ${fmt(metrics.complexity)}`,
      metrics.ca !== undefined && `used by ${fmt(metrics.ca)}`,
      metrics.ce !== undefined && `uses ${fmt(metrics.ce)}`,
    ].filter(Boolean);
    const view = app.state?.view ?? '';
    const level = app.view === app.zoomView ? 'auto' : app.state?.level ?? '';
    const inner = h('div', { class: 'ar-eye-inner' },
      h('div', { class: 'ar-top' }, `${view} · ${level}${app.statusLine ? ` · ${app.statusLine}` : ''}`),
      h('div', { class: 'ar-message' }, this.texts.message),
      h('div', { class: `ar-hint${this.texts.hint ? '' : ' fade'}` }, this.texts.hint),
      h('div', { class: `ar-reticle${this.hovered ? ' on' : ''}` }),
      h('div', { class: 'ar-card' }, shown ? [
        h('div', { class: 'k' }, `${node ? '' : 'Looking at · '}${shown.kind}`),
        h('div', { class: 'n' }, shown.name),
        parts.length ? h('div', { class: 'm' }, parts.join(' · ')) : null,
      ] : []),
    );
    for (const eye of this.hud.children) eye.replaceChildren(inner.cloneNode(true));
    this.hudShift = null;
    this.placeHud();
  }

  /**
   * Puts the HUD (reticle, card) at the map's depth: shifted towards the nose in each eye by the disparity
   * of the map's distance. At zero disparity it would sit on the glasses' screen plane, behind the map, and
   * the reticle would be seen double while looking at a node.
   */
  placeHud() {
    if (!this.hud) return;
    const { stage } = this.app;
    const distance = stage.camera.position.distanceTo(stage.controls.target) / stage.unitsPerMeter;
    const focal = stage.height / 2 / Math.tan((stage.camera.fov * Math.PI) / 360);
    const half = this.settings.sbs === 'half';
    const shift = Math.round((this.settings.ipd / 2000) * (1 / Math.max(0.3, distance) - 1 / this.settings.convergence) * focal * (half ? 0.5 : 1));
    if (shift === this.hudShift) return;
    this.hudShift = shift;
    const [left, right] = [...this.hud.children].map((eye) => eye.firstChild);
    const squeeze = half ? ' scaleX(0.5)' : '';
    for (const [inner, dx] of [[left, shift], [right, -shift]]) {
      if (!inner) continue;
      inner.style.width = half ? '200%' : '';
      inner.style.transform = `translateX(${dx}px)${squeeze}`;
    }
  }
}

/** The glasses among the screens (Chrome / Edge, with the user's permission), or null. */
export async function findGlassesScreen() {
  try {
    const { screens } = await window.getScreenDetails();
    return (
      screens.find((s) => /xreal|nreal|viture|rokid|rayneo/i.test(s.label)) ??
      screens.find((s) => s.width === 3840 && s.height === 1080) ??
      screens.find((s) => Math.abs(s.width / s.height - 32 / 9) < 0.05) ??
      screens.find((s) => !s.isPrimary && !s.isInternal) ??
      null
    );
  } catch {
    return null;
  }
}
