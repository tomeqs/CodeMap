import { AdditiveBlending, InstancedBufferAttribute, MeshStandardNodeMaterial, PointsNodeMaterial, Sprite } from 'three/webgpu';
import {
  abs,
  attribute,
  diffuseColor,
  float,
  floor,
  fract,
  hash,
  instancedBufferAttribute,
  mrt,
  normalLocal,
  output,
  positionLocal,
  positionWorld,
  step,
  texture,
  uniform,
  uv,
  vec2,
  vec4,
} from 'three/tsl';
import { dotTexture } from './textures.js';

/**
 * Lets a material feed the bloom with its own colour (× `amount`, 0: none). Only what glows blooms: the
 * stage blooms the emissive output (see Stage), which lit materials fill with their emissive colour and
 * unlit ones (links, particles, sprites, planes) through this.
 */
export function feedsBloom(material, amount = 1) {
  material.mrtNode = mrt({ emissive: vec4(output.rgb.mul(amount), output.a) });
  return material;
}

/** How much of a unit's colour goes into the bloom. */
const UNIT_BLOOM = 0.8;

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
  // The bloom gets more than the surface shows: a soft halo around every unit, its own colour.
  material.mrtNode = mrt({ emissive: vec4(diffuseColor.rgb.mul(UNIT_BLOOM), 1) });
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

/**
 * Round sprites, one instance each, with a size in pixels (or world units with `sizeAttenuation`).
 * WebGPU draws point primitives one pixel wide, so points are instanced quads.
 */
export function createDots(max, { size = 3, sizeAttenuation = true, opacity = 1, glow = 1 } = {}) {
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
  feedsBloom(material, glow);
  const sprite = new Sprite(material);
  sprite.count = 0;
  sprite.frustumCulled = false;
  return { sprite, positions, colors };
}
