import { AdditiveBlending, InstancedBufferAttribute, PointsNodeMaterial, Sprite } from 'three/webgpu';
import { attribute, exp, float, hash, instanceIndex, select, sin, texture, time, uniform, uv, vec4 } from 'three/tsl';
import { glowTexture } from './textures.js';

/** Corona diameter in unit radii (world units). */
const SIZE = 6;

/**
 * A soft, slowly breathing glow around every unit, in its colour: one instanced sprite per unit, placed
 * from the position store by the instance index (the unit's place in the store), so it follows the layout
 * for free. Colours follow the units' (dimmed with the selection, brighter on hover); the overall strength
 * falls with the number of units, so big maps glow rather than turn white.
 */
export class Coronas {
  constructor(store) {
    this.store = store;
    this.capacity = 0;
    this.count = 0;
    this.strength = uniform(0.5);
    /** The wave of light after a click, in hops from the selected unit (far below 0: none). */
    this.waveFront = uniform(-100);
    const material = new PointsNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, sizeAttenuation: true, fog: false });
    material.positionNode = store.positionAt(instanceIndex).xyz;
    // Point sizes are pixels at half the canvas height of distance: world size / tan(fov / 2) (fov 55°).
    // A unit flares up when the wave reaches it.
    const hop = attribute('aHop', 'float');
    const away = hop.sub(this.waveFront);
    const flare = select(hop.greaterThanEqual(0), exp(away.mul(away).mul(-5)), float(0));
    material.sizeNode = attribute('aRadius', 'float').mul(SIZE / Math.tan((55 * Math.PI) / 360)).mul(store.introOf(instanceIndex)).mul(flare.mul(0.6).add(1));
    const breathe = sin(time.mul(0.7).add(hash(instanceIndex).mul(Math.PI * 2))).mul(0.15).add(0.85);
    const glow = this.strength.mul(breathe).add(flare.mul(0.9));
    material.colorNode = texture(glowTexture(), uv()).mul(vec4(attribute('aColor', 'vec3').mul(glow), 1));
    this.material = material;
    this.sprite = new Sprite(material);
    // Sprites share one quad geometry; this one carries the per-unit attributes.
    this.sprite.geometry = this.sprite.geometry.clone();
    this.sprite.count = 0;
    this.sprite.frustumCulled = false;
    this.sprite.renderOrder = 1;
    this.strengthFor(0);
  }

  /** Room for `count` units (attributes grow, never shrink). */
  setCount(count) {
    this.count = count;
    if (count > this.capacity) {
      const capacity = Math.max(count, Math.ceil(this.capacity * 1.5), 64);
      const geometry = this.sprite.geometry;
      this.colors = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      this.radii = new InstancedBufferAttribute(new Float32Array(capacity), 1);
      this.hops = new InstancedBufferAttribute(new Float32Array(capacity).fill(-1), 1);
      geometry.setAttribute('aColor', this.colors);
      geometry.setAttribute('aRadius', this.radii);
      geometry.setAttribute('aHop', this.hops);
      this.capacity = capacity;
      geometry.dispose(); // new GPU buffers at the next frame
    }

    this.sprite.count = count;
    this.strengthFor(count);
  }

  /** Fewer units, brighter coronas: one big glow per cluster rather than a white sheet. */
  strengthFor(count) {
    this.strength.value = Math.max(0.08, Math.min(0.9, 0.9 / Math.sqrt(Math.max(1, count / 250))));
  }

  /** Hops from the selected unit (-1: the wave does not reach it); null clears all. Uploads. */
  setHops(hopOf) {
    this.hops.array.fill(-1);
    if (hopOf) for (const [index, hop] of hopOf) this.hops.array[index] = hop;
    flush(this.hops, 1);
  }

  setColor(index, color) {
    color.toArray(this.colors.array, index * 3);
  }

  setRadius(index, radius) {
    this.radii.array[index] = radius;
  }

  /** Uploads every colour / radius, or (indices given) just those units'. */
  flushColors(indices) {
    flush(this.colors, 3, indices);
  }

  flushRadii(indices) {
    flush(this.radii, 1, indices);
  }

  dispose() {
    this.sprite.geometry.dispose();
    this.material.dispose();
  }
}

function flush(attr, size, indices) {
  if (!attr) return;
  if (indices) for (const i of indices) attr.addUpdateRange(i * size, size);
  else attr.clearUpdateRanges();
  attr.needsUpdate = true;
}
