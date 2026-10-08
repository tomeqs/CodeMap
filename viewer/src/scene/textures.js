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
