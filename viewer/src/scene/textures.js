import { CanvasTexture, SRGBColorSpace } from 'three';

let cachedDot;
/** Soft round sprite used for particles, stars and the selection halo. */
export function dotTexture() {
  if (cachedDot) return cachedDot;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.25, 'rgba(255,255,255,0.85)');
  gradient.addColorStop(0.6, 'rgba(255,255,255,0.18)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  cachedDot = new CanvasTexture(canvas);
  cachedDot.colorSpace = SRGBColorSpace;
  return cachedDot;
}

/** A canvas texture from a draw function, cached by key. */
const cache = new Map();
function canvasTexture(key, size, draw) {
  if (cache.has(key)) return cache.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = size[0];
  canvas.height = size[1];
  draw(canvas.getContext('2d'), size[0], size[1]);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  cache.set(key, texture);
  return texture;
}

/** A wide, very soft glow (node coronas): bright core falling off smoothly to nothing. */
export function glowTexture() {
  return canvasTexture('glow', [128, 128], (ctx, w) => {
    const gradient = ctx.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      gradient.addColorStop(t, `rgba(255,255,255,${(Math.exp(-t * t * 5.5) * (1 - t)).toFixed(3)})`);
    }
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, w);
  });
}

/** A star with four thin rays (the brightest stars). */
export function sparkleTexture() {
  return canvasTexture('sparkle', [128, 128], (ctx, w) => {
    const c = w / 2;
    const core = ctx.createRadialGradient(c, c, 0, c, c, c * 0.45);
    core.addColorStop(0, 'rgba(255,255,255,1)');
    core.addColorStop(0.3, 'rgba(255,255,255,0.5)');
    core.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = core;
    ctx.fillRect(0, 0, w, w);
    ctx.globalCompositeOperation = 'lighter';
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      const ray = ctx.createLinearGradient(c - dx * c, c - dy * c, c + dx * c, c + dy * c);
      ray.addColorStop(0, 'rgba(255,255,255,0)');
      ray.addColorStop(0.5, 'rgba(255,255,255,0.9)');
      ray.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = ray;
      if (dx) ctx.fillRect(0, c - 1.2, w, 2.4);
      else ctx.fillRect(c - 1.2, 0, 2.4, w);
    }
  });
}

/**
 * A comet across a square: bright head on the right (u ≈ 0.86), a tail fading to the left, `aspect` times
 * longer than wide. Square, so a sprite can turn it any way (sprites scale after they turn).
 */
export function cometTexture(aspect = 5) {
  return canvasTexture(`comet${aspect}`, [128, 128], (ctx, w, h) => {
    const image = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = x / (w - 1);
        const v = ((y + 0.5) / h - 0.5) * aspect; // in comet widths
        const head = Math.exp(-((u - 0.86) ** 2) / 0.004 - (v * v) / 0.02);
        const width = 0.012 + 0.05 * u;
        const tail = u < 0.88 ? u ** 2.2 * Math.exp(-(v * v) / width) : Math.exp(-((u - 0.88) ** 2) / 0.0015 - (v * v) / 0.05);
        const a = Math.min(1, head + tail * 0.85);
        const i = (y * w + x) * 4;
        image.data[i] = image.data[i + 1] = image.data[i + 2] = 255;
        image.data[i + 3] = Math.round(a * 255);
      }
    }
    ctx.putImageData(image, 0, 0);
  });
}

/** A thin soft ring (the shock wave around a selected node). */
export function ringTexture() {
  return canvasTexture('ring', [128, 128], (ctx, w) => {
    const c = w / 2;
    const gradient = ctx.createRadialGradient(c, c, 0, c, c, c);
    gradient.addColorStop(0, 'rgba(255,255,255,0)');
    gradient.addColorStop(0.72, 'rgba(255,255,255,0.05)');
    gradient.addColorStop(0.86, 'rgba(255,255,255,0.9)');
    gradient.addColorStop(0.93, 'rgba(255,255,255,0.25)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, w);
  });
}

/** A wisp of nebula: fractal value noise in a soft round falloff (white; tinted by the material). */
export function nebulaTexture(seed) {
  return canvasTexture(`nebula${seed}`, [256, 256], (ctx, w) => {
    const hash = (x, y) => {
      let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };
    const noise = (x, y) => {
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      const fx = x - xi;
      const fy = y - yi;
      const sx = fx * fx * (3 - 2 * fx);
      const sy = fy * fy * (3 - 2 * fy);
      const a = hash(xi, yi) + (hash(xi + 1, yi) - hash(xi, yi)) * sx;
      const b = hash(xi, yi + 1) + (hash(xi + 1, yi + 1) - hash(xi, yi + 1)) * sx;
      return a + (b - a) * sy;
    };
    const image = ctx.createImageData(w, w);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        let value = 0;
        let amplitude = 0.5;
        let frequency = 3 / w;
        for (let octave = 0; octave < 5; octave++) {
          value += amplitude * noise(x * frequency, y * frequency);
          amplitude *= 0.5;
          frequency *= 2.1;
        }
        const dx = x / w - 0.5;
        const dy = y / w - 0.5;
        const falloff = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) * 2) ** 1.6;
        const a = Math.max(0, value - 0.38) * 2.2 * falloff;
        const i = (y * w + x) * 4;
        image.data[i] = image.data[i + 1] = image.data[i + 2] = 255;
        image.data[i + 3] = Math.round(Math.min(1, a) * 255);
      }
    }
    ctx.putImageData(image, 0, 0);
  });
}
