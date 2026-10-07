import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  LineBasicMaterial,
  LineSegments,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
} from 'three';
import { dotTexture } from './stage.js';

/**
 * Standard material whose instance colour also feeds the emissive term, so nodes look self-lit
 * and pick up bloom. `glow` controls how much they shine.
 */
export function glowMaterial(glow = 0.55, options = {}) {
  const material = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.15, ...options });
  material.userData.glow = { value: glow };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGlow = material.userData.glow;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * uGlow;');
  };
  return material;
}

/**
 * Night-city building material: lit windows are drawn procedurally from world coordinates on the
 * vertical faces; roofs stay plain. Instance colours tint the facade.
 */
export function buildingMaterial() {
  const material = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.1 });
  material.userData.windows = { value: 0.55 };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWindows = material.userData.windows;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos;\nvarying vec3 vObjNormal;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vec4 wp = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          wp = instanceMatrix * wp;
        #endif
        wp = modelMatrix * wp;
        vWorldPos = wp.xyz;
        vObjNormal = normal;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uWindows;\nvarying vec3 vWorldPos;\nvarying vec3 vObjNormal;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float side = 1.0 - step(0.5, abs(vObjNormal.y));
        vec2 cell = vec2((vWorldPos.x + vWorldPos.z) * 0.9, vWorldPos.y * 0.55);
        vec2 f = fract(cell);
        float win = step(0.25, f.x) * step(f.x, 0.75) * step(0.3, f.y) * step(f.y, 0.75);
        float lit = step(0.42, fract(sin(dot(floor(cell), vec2(12.9898, 78.233))) * 43758.5453));
        totalEmissiveRadiance += diffuseColor.rgb * (0.12 + side * win * lit * uWindows);`,
      );
  };
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

/** Points that travel along edges to show direction of the relationship. */
export class FlowParticles {
  constructor(max = 6000, size = 3.2) {
    this.max = max;
    this.geometry = new BufferGeometry();
    this.positions = new Float32Array(max * 3);
    this.colors = new Float32Array(max * 3);
    this.geometry.setAttribute('position', new BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('color', new BufferAttribute(this.colors, 3));
    this.geometry.setDrawRange(0, 0);
    this.material = new PointsMaterial({
      size,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      map: dotTexture(),
      fog: false,
    });
    this.points = new Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.paths = [];
    this.time = 0;
  }

  /** paths: [{ at(t, out) -> Vector3, color: Color, count, speed }] */
  setPaths(paths) {
    this.paths = paths;
    let total = 0;
    for (const p of paths) total += p.count;
    this.count = Math.min(this.max, total);
    this.geometry.setDrawRange(0, this.count);
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

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

export const WHITE = new Color(1, 1, 1);
