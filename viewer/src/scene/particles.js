import { AdditiveBlending, InstancedBufferAttribute, PointsNodeMaterial, Sprite } from 'three/webgpu';
import { attribute, fract, sin, texture, time, uniform, uv, vec4 } from 'three/tsl';
import { linkPoint } from './link-mesh.js';
import { dotTexture } from './textures.js';

/**
 * Particles flowing along links (the direction of the dependency), animated entirely on the GPU: each
 * particle knows its link's two unit indices, a speed and a phase; the vertex shader places it from the
 * position store and the clock. Nothing is uploaded per frame.
 */
export class GpuParticles {
  constructor(store, { max = 100000, size = 2.6, arc = false } = {}) {
    this.store = store;
    this.max = max;
    this.capacity = 0;
    this.count = 0;
    const material = new PointsNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, sizeAttenuation: true, fog: false });
    const ends = attribute('aEnds', 'vec2');
    const motion = attribute('aMotion', 'vec2'); // speed (loops per second), phase
    const t = fract(time.mul(motion.x).add(motion.y));
    material.positionNode = linkPoint(store.positionAt(ends.x).xyz, store.positionAt(ends.y).xyz, t, arc);
    const fade = sin(t.mul(Math.PI));
    material.colorNode = texture(dotTexture(), uv()).mul(vec4(attribute('aColor', 'vec3').mul(fade), 1));
    this.size = uniform(size);
    material.sizeNode = this.size;
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
