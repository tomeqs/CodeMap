import { AdditiveBlending, InstancedBufferAttribute, PointsNodeMaterial, Sprite } from 'three/webgpu';
import { atan, attribute, cameraProjectionMatrix, fract, max, modelViewMatrix, screenSize, sin, texture, time, uniform, uv, vec4 } from 'three/tsl';
import { linkPoint } from './link-mesh.js';
import { cometTexture } from './textures.js';

/** A comet is this many times longer than wide (its width is the particle's size). */
const TAIL = 5;

/** Particles per link at the "particles" option (0 off, 1 normal, more or less), from its usual number. */
export function particlesPerLink(usual, density = 1) {
  return density > 0 ? Math.max(1, Math.round(usual * density)) : 0;
}

/**
 * Comets flowing along links (the direction of the dependency), animated entirely on the GPU: each
 * particle knows its link's two unit indices, a speed and a phase; the vertex shader places it from the
 * position store and the clock, and turns its tail away from where it flies on screen. Nothing is
 * uploaded per frame.
 */
export class GpuParticles {
  constructor(store, { max: limit = 100000, size = 2.6, arc = false } = {}) {
    this.store = store;
    this.max = limit;
    this.capacity = 0;
    this.count = 0;
    const material = new PointsNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, sizeAttenuation: true, fog: false });
    const ends = attribute('aEnds', 'vec2');
    const motion = attribute('aMotion', 'vec2'); // speed (loops per second), phase
    const t = fract(time.mul(motion.x).add(motion.y));
    const p0 = store.positionAt(ends.x).xyz;
    const p1 = store.positionAt(ends.y).xyz;
    const head = linkPoint(p0, p1, t, arc);
    material.positionNode = head;
    // The direction of flight on screen (in pixels): from a point just behind the head to the head.
    const mvp = cameraProjectionMatrix.mul(modelViewMatrix);
    const behind = mvp.mul(vec4(linkPoint(p0, p1, max(t.sub(0.02), 0), arc), 1));
    const ahead = mvp.mul(vec4(head, 1));
    const direction = ahead.xy.div(max(ahead.w, 0.05)).sub(behind.xy.div(max(behind.w, 0.05))).mul(screenSize);
    material.rotationNode = atan(direction.y, direction.x);
    const fade = sin(t.mul(Math.PI));
    material.colorNode = texture(cometTexture(TAIL), uv()).mul(vec4(attribute('aColor', 'vec3').mul(fade), 1));
    this.size = uniform(size);
    material.sizeNode = this.size.mul(TAIL);
    this.sprite = new Sprite(material);
    // Sprites share one quad geometry; this one gets its own copy to carry the per-particle attributes.
    this.sprite.geometry = this.sprite.geometry.clone();
    this.sprite.count = 0;
    this.sprite.frustumCulled = false;
    this.points = this.sprite; // what views add to their group
  }

  /** paths: [{ source, target (unit indices), color: Color, count, speed }] – `count` particles per path. */
  setPaths(paths) {
    let total = 0;
    for (const p of paths) total += p.count;
    total = Math.min(total, this.max);
    this.ensure(Math.max(1, total));
    const ends = this.ends.array;
    const colors = this.colors.array;
    const motion = this.motion.array;
    let i = 0;
    for (const p of paths) {
      for (let k = 0; k < p.count && i < total; k++, i++) {
        ends[i * 2] = p.source;
        ends[i * 2 + 1] = p.target;
        colors[i * 3] = p.color.r;
        colors[i * 3 + 1] = p.color.g;
        colors[i * 3 + 2] = p.color.b;
        motion[i * 2] = p.speed;
        motion[i * 2 + 1] = k / p.count + (p.phase ?? Math.random());
      }
    }

    for (const attr of [this.ends, this.colors, this.motion]) attr.needsUpdate = true;
    this.count = total;
    this.sprite.count = total;
  }

  ensure(count) {
    if (count <= this.capacity) return;
    const capacity = Math.max(count, Math.ceil(this.capacity * 1.5), 64);
    const geometry = this.sprite.geometry;
    const make = (name, size) => {
      const attr = new InstancedBufferAttribute(new Float32Array(capacity * size), size);
      geometry.setAttribute(name, attr);
      return attr;
    };
    this.ends = make('aEnds', 2);
    this.colors = make('aColor', 3);
    this.motion = make('aMotion', 2);
    this.capacity = capacity;
    geometry.dispose(); // the GPU buffers are made again for the new attributes
  }

  dispose() {
    this.sprite.geometry.dispose();
    this.sprite.material.dispose();
  }
}
