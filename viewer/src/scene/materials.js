import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  InstancedBufferAttribute,
  LineBasicMaterial,
  LineSegments,
  MeshStandardNodeMaterial,
  PointsNodeMaterial,
  Sprite,
} from 'three/webgpu';
import { abs, attribute, diffuseColor, float, floor, fract, hash, instancedBufferAttribute, normalLocal, positionLocal, positionWorld, step, texture, uniform, uv, vec2, vec4 } from 'three/tsl';
import { dotTexture } from './textures.js';

/**
 * Standard material whose instance colour also feeds the emissive term, so nodes look self-lit
 * and pick up bloom. `glow` controls how much they shine.
 */
export function glowMaterial(glow = 0.55, options = {}) {
  const material = new MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.15, ...options });
  material.userData.glow = uniform(glow);
  material.emissiveNode = diffuseColor.rgb.mul(material.userData.glow);
  return material;
}

/**
 * Glowing units (galaxy, layers, semantic zoom) drawn straight from the position store: per instance the
 * unit's index into the store, its colour and its size. A moving layout only uploads the store.
 */
export function unitMaterial(store, glow = 0.36) {
  const material = new MeshStandardNodeMaterial({ roughness: 0.35, metalness: 0.15 });
  material.userData.glow = uniform(glow);
  const center = store.positionAt(attribute('aUnit', 'float')).xyz;
  material.positionNode = positionLocal.mul(attribute('aScale', 'float')).add(center);
  material.colorNode = attribute('aColor', 'vec3');
  material.emissiveNode = diffuseColor.rgb.mul(material.userData.glow);
  return material;
}

/**
 * Night-city building material: lit windows are drawn procedurally from world coordinates on the
 * vertical faces; roofs stay plain. Instance colours tint the facade.
 */
export function buildingMaterial() {
  const material = new MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.1 });
  const windows = uniform(0.55);
  material.userData.windows = windows;
  const side = float(1).sub(step(0.5, abs(normalLocal.y)));
  const cell = vec2(positionWorld.x.add(positionWorld.z).mul(0.9), positionWorld.y.mul(0.55));
  const f = fract(cell);
  const window = step(0.25, f.x).mul(step(f.x, 0.75)).mul(step(0.3, f.y)).mul(step(f.y, 0.75));
  const corner = floor(cell);
  const lit = step(0.42, hash(corner.x.mul(127.1).add(corner.y.mul(311.7))));
  material.emissiveNode = diffuseColor.rgb.mul(float(0.12).add(side.mul(window).mul(lit).mul(windows)));
  return material;
}

/** Line segments with per-vertex colours, rendered additively ("glowing threads"). */
export function createLines(maxSegments) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(maxSegments * 6), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(maxSegments * 6), 3));
  geometry.setDrawRange(0, 0);
  const material = new LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: AdditiveBlending,
    fog: false,
  });
  const lines = new LineSegments(geometry, material);
  lines.frustumCulled = false;
  return lines;
}

/**
 * Round sprites, one instance each, with a size in pixels (or world units with `sizeAttenuation`).
 * WebGPU draws point primitives one pixel wide, so points are instanced quads.
 */
export function createDots(max, { size = 3, sizeAttenuation = true, opacity = 1 } = {}) {
  const positions = new InstancedBufferAttribute(new Float32Array(max * 3), 3);
  const colors = new InstancedBufferAttribute(new Float32Array(max * 3), 3);
  const material = new PointsNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    sizeAttenuation,
    fog: false,
  });
  material.positionNode = instancedBufferAttribute(positions);
  material.colorNode = texture(dotTexture(), uv()).mul(vec4(instancedBufferAttribute(colors), opacity));
  material.sizeNode = uniform(size);
  const sprite = new Sprite(material);
  sprite.count = 0;
  sprite.frustumCulled = false;
  return { sprite, positions, colors };
}

/** Points that travel along edges to show direction of the relationship. */
export class FlowParticles {
  constructor(max = 6000, size = 3.2) {
    this.max = max;
    const { sprite, positions, colors } = createDots(max, { size });
    this.points = sprite;
    this.positionAttribute = positions;
    this.colorAttribute = colors;
    this.positions = positions.array;
    this.colors = colors.array;
    this.paths = [];
    this.time = 0;
    this.count = 0;
  }

  /** paths: [{ at(t, out) -> Vector3, color: Color, count, speed }] */
  setPaths(paths) {
    this.paths = paths;
    let total = 0;
    for (const p of paths) total += p.count;
    this.count = Math.min(this.max, total);
    this.points.count = this.count;
  }

  update(dt, tmp) {
    this.time += dt;
    let i = 0;
    for (const path of this.paths) {
      for (let k = 0; k < path.count && i < this.count; k++, i++) {
        const t = (this.time * path.speed + k / path.count + path.phase) % 1;
        path.at(t, tmp);
        this.positions[i * 3] = tmp.x;
        this.positions[i * 3 + 1] = tmp.y;
        this.positions[i * 3 + 2] = tmp.z;
        const fade = Math.sin(Math.PI * t);
        this.colors[i * 3] = path.color.r * fade;
        this.colors[i * 3 + 1] = path.color.g * fade;
        this.colors[i * 3 + 2] = path.color.b * fade;
      }
    }

    this.positionAttribute.needsUpdate = true;
    this.colorAttribute.needsUpdate = true;
  }

  dispose() {
    this.points.material.dispose();
  }
}

export const WHITE = new Color(1, 1, 1);
