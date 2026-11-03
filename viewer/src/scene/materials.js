import { AdditiveBlending, InstancedBufferAttribute, MeshStandardNodeMaterial, PointsNodeMaterial, Sprite } from 'three/webgpu';
import {
  abs,
  attribute,
  clamp,
  diffuseColor,
  float,
  floor,
  fract,
  hash,
  instanceIndex,
  instancedBufferAttribute,
  normalLocal,
  positionLocal,
  positionWorld,
  step,
  texture,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { dotTexture } from './textures.js';

/**
 * Glowing units (galaxy, layers, semantic zoom) drawn straight from the position store: per instance the
 * unit's index into the store, its colour and its size. A moving layout only uploads the store.
 */
export function unitMaterial(store, glow = 0.36) {
  const material = new MeshStandardNodeMaterial({ roughness: 0.35, metalness: 0.15 });
  material.userData.glow = uniform(glow);
  const unit = attribute('aUnit', 'float');
  const center = store.positionAt(unit).xyz;
  // While a new layout unfolds, units grow from a fifth of their size.
  const grow = store.introOf(unit).mul(0.8).add(0.2);
  material.positionNode = positionLocal.mul(attribute('aScale', 'float').mul(grow)).add(center);
  material.colorNode = attribute('aColor', 'vec3');
  material.emissiveNode = diffuseColor.rgb.mul(material.userData.glow);
  return material;
}

/** Seconds a building takes to rise, and up to how much later some start. */
const RISE = 1.1;
const RISE_STAGGER = 0.6;

/**
 * Night-city building material: lit windows are drawn procedurally from world coordinates on the
 * vertical faces; roofs stay plain. Instance colours tint the facade. `userData.rise` (seconds since a
 * new city was built; large: done) lets the buildings grow out of the ground one after another.
 */
export function buildingMaterial() {
  const material = new MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.1 });
  const rise = uniform(1e6);
  material.userData.rise = rise;
  const k = clamp(rise.sub(hash(float(instanceIndex)).mul(RISE_STAGGER)).div(RISE), 0, 1);
  const height = float(1).sub(float(1).sub(k).pow(3)).mul(0.98).add(0.02);
  material.positionNode = positionLocal.mul(vec3(1, height, 1));
  const windows = uniform(0.55);
  material.userData.windows = windows;
  const side = float(1).sub(step(0.5, abs(normalLocal.y)));
  // Windows where they will be once the building stands (not squeezed while it rises).
  const cell = vec2(positionWorld.x.add(positionWorld.z).mul(0.9), positionWorld.y.div(varying(height, 'vRise')).mul(0.55));
  const f = fract(cell);
  const window = step(0.25, f.x).mul(step(f.x, 0.75)).mul(step(0.3, f.y)).mul(step(f.y, 0.75));
  const corner = floor(cell);
  const lit = step(0.42, hash(corner.x.mul(127.1).add(corner.y.mul(311.7))));
  material.emissiveNode = diffuseColor.rgb.mul(float(0.12).add(side.mul(window).mul(lit).mul(windows)));
  return material;
}

/**
 * Columns of the dependency matrix: plain boxes that glow in their own colour (bright ones, e.g. dependencies
 * against the layers, catch the bloom) and rise out of the grid one after another when a matrix is built
 * (`userData.rise`, like the city's buildings).
 */
export function columnMaterial(glow = 0.3) {
  const material = new MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.1 });
  const rise = uniform(1e6);
  material.userData.rise = rise;
  const k = clamp(rise.sub(hash(float(instanceIndex)).mul(RISE_STAGGER)).div(RISE), 0, 1);
  const height = float(1).sub(float(1).sub(k).pow(3)).mul(0.98).add(0.02);
  material.positionNode = positionLocal.mul(vec3(1, height, 1));
  material.userData.glow = uniform(glow);
  material.emissiveNode = diffuseColor.rgb.mul(material.userData.glow);
  return material;
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
