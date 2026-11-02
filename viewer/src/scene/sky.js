import { AdditiveBlending, Color, Group, InstancedBufferAttribute, PointsNodeMaterial, Sprite, SpriteNodeMaterial } from 'three/webgpu';
import { float, instancedBufferAttribute, sin, texture, time, uniform, uv, vec4 } from 'three/tsl';
import { dotTexture, nebulaTexture, sparkleTexture } from './textures.js';

/** A small seeded random generator: the same sky every time. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * The night sky behind every map: thousands of stars, each twinkling in its own rhythm (in the shader:
 * nothing is uploaded per frame), a few bright ones with four rays, and faint coloured nebulae far away,
 * drifting slowly. It only moves while frames are drawn, so it lives with the "living" motion setting.
 */
export class Sky {
  constructor() {
    this.group = new Group();
    const rand = random(7);
    this.nebulaGlow = uniform(1);

    // Nebulae first (behind everything, additive): tinted wisps on a far shell.
    const tints = ['#6a4cff', '#1fb5c9', '#b44cff', '#2f6bff', '#ff5ca8', '#24c9a0', '#7a5cff'];
    this.nebulae = new Group();
    tints.forEach((tint, i) => {
      const material = new SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, fog: false });
      const drift = (rand() - 0.5) * 0.01;
      material.rotationNode = time.mul(drift).add(rand() * Math.PI * 2);
      material.colorNode = texture(nebulaTexture(i % 4), uv()).mul(vec4(new Color(tint).multiplyScalar(0.07 + rand() * 0.06), 1)).mul(this.nebulaGlow);
      const sprite = new Sprite(material);
      const [x, y, z] = onSphere(rand, 14000);
      sprite.position.set(x, y * 0.6, z);
      sprite.scale.setScalar(9000 + rand() * 9000);
      sprite.renderOrder = -2;
      this.nebulae.add(sprite);
    });

    this.stars = starField(9000, rand, { texture: dotTexture(), size: () => (rand() < 0.06 ? 2.8 + rand() * 1.4 : 1.3 + rand() * 1.3), speed: [0.6, 3.2], depth: [0.15, 0.8] });
    this.sparkles = starField(140, rand, { texture: sparkleTexture(), size: () => 9 + rand() * 9, speed: [0.25, 0.9], depth: [0.35, 0.7], rotate: true });
    this.group.add(this.nebulae, this.stars, this.sparkles);
  }

  get visible() {
    return this.group.visible;
  }

  /** stars: shown at all; nebula: 0..1 (dimmer behind the code city). */
  set({ stars = true, nebula = 1 } = {}) {
    this.group.visible = stars;
    this.nebulae.visible = nebula > 0;
    this.nebulaGlow.value = nebula;
  }

  /** The slow turn of the sky (the twinkling runs on the GPU clock). */
  update(dt) {
    this.group.rotation.y += dt * 0.004;
  }
}

function onSphere(rand, radius) {
  const theta = rand() * Math.PI * 2;
  const phi = Math.acos(2 * rand() - 1);
  return [radius * Math.sin(phi) * Math.cos(theta), radius * Math.cos(phi), radius * Math.sin(phi) * Math.sin(theta)];
}

/**
 * Instanced star sprites with a size in pixels. Per star: position, colour and (size, phase, speed, depth):
 * the brightness swings by `depth` at `speed`, so some stars barely flicker and others pulse.
 */
function starField(count, rand, { texture: map, size, speed, depth, rotate = false }) {
  const positions = new InstancedBufferAttribute(new Float32Array(count * 3), 3);
  const colors = new InstancedBufferAttribute(new Float32Array(count * 3), 3);
  const params = new InstancedBufferAttribute(new Float32Array(count * 4), 4);
  const color = new Color();
  for (let i = 0; i < count; i++) {
    const [x, y, z] = onSphere(rand, 6000 + rand() * 9000);
    positions.setXYZ(i, x, y, z);
    // Mostly blue-white, some warm.
    if (rand() < 0.12) color.setHSL(0.06 + rand() * 0.06, 0.55, 0.62 + rand() * 0.3);
    else color.setHSL(0.55 + rand() * 0.15, 0.5, 0.55 + rand() * 0.4);
    colors.setXYZ(i, color.r, color.g, color.b);
    params.setXYZW(i, size(), rand() * Math.PI * 2, speed[0] + rand() * (speed[1] - speed[0]), depth[0] + rand() * (depth[1] - depth[0]));
  }

  const material = new PointsNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, sizeAttenuation: false, fog: false });
  const p = instancedBufferAttribute(params);
  const wave = sin(time.mul(p.z).add(p.y)).mul(0.5).add(0.5);
  const brightness = float(1).sub(p.w.mul(float(1).sub(wave.mul(wave))));
  material.positionNode = instancedBufferAttribute(positions);
  material.colorNode = texture(map, uv()).mul(vec4(instancedBufferAttribute(colors).mul(brightness).mul(0.8), 1));
  material.sizeNode = p.x;
  if (rotate) material.rotationNode = time.mul(p.z).mul(0.12).add(p.y);
  const sprite = new Sprite(material);
  sprite.count = count;
  sprite.frustumCulled = false;
  return sprite;
}
