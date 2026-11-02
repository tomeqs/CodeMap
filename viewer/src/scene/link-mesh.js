import { AdditiveBlending, BufferAttribute, BufferGeometry, DoubleSide, InstancedBufferAttribute, Mesh, MeshBasicNodeMaterial } from 'three/webgpu';
import {
  abs,
  attribute,
  cameraProjectionMatrix,
  distance,
  exp,
  float,
  fract,
  max,
  min,
  mix,
  modelViewMatrix,
  normalize,
  screenDPR,
  select,
  smoothstep,
  time,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
  viewportSize,
} from 'three/tsl';
import { uploadAll, uploadRange } from './uploads.js';

/** Smallest clip-space w kept in front of the camera when a link crosses it. */
const NEAR_W = 0.05;
/** Flowing dashes: one every this many CSS pixels along the link, moving this many dashes per second. */
const DASH = 18;
const DASH_SPEED = 1.6;

/**
 * Links as thick glowing ribbons: one instanced strip per link, widened in screen space in the vertex
 * shader, with soft edges. Both ends are read from the position store, so a moving layout costs nothing
 * here. `arc` bends every link up into a quadratic curve (the code city).
 *
 * Per link: the two unit indices, a colour, head and tail intensities (fading along the link), a
 * width in pixels and how much it flows: dashes running from the source to the target (the direction of
 * the dependency; they move with the clock, so a view showing them keeps drawing ambient frames).
 */
export class LinkMesh {
  constructor(store, { arc = false, segments = arc ? 18 : 1 } = {}) {
    this.store = store;
    this.arc = arc;
    this.segments = segments;
    this.capacity = 0;
    this.count = 0;
    /** Links with dashes: while there are any, the view keeps drawing (ambient frames). */
    this.flowing = 0;
    this.material = linkMaterial(store, { arc, segments });
    /** Where the wave of light from a selection is, in hops (see setWave); far below 0: none. */
    this.waveFront = this.material.userData.waveFront;
    this.mesh = new Mesh(stripGeometry(segments), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.renderOrder = 1;
  }

  /** Room for `count` links (attributes are reallocated only when growing); styles start over. */
  setCount(count) {
    this.count = count;
    this.flows?.array.fill(0);
    this.waves?.array.fill(-1);
    this.flowing = 0;
    if (count > this.capacity || !this.ends) {
      const capacity = Math.max(count, Math.ceil(this.capacity * 1.5), 16);
      const geometry = this.mesh.geometry;
      const grow = (name, size) => {
        const attr = new InstancedBufferAttribute(new Float32Array(capacity * size), size);
        geometry.setAttribute(name, attr);
        return attr;
      };
      this.ends = grow('aEnds', 2);
      this.colors = grow('aColor', 3);
      this.intensity = grow('aIntensity', 2);
      this.widths = grow('aWidth', 1);
      this.flows = grow('aFlow', 1);
      this.waves = grow('aWave', 2);
      this.waves.array.fill(-1);
      this.capacity = capacity;
      geometry.dispose(); // the old GPU buffers go; new ones are made at the next frame
    }

    this.mesh.count = count;
  }

  setEnds(i, source, target) {
    this.ends.array[i * 2] = source;
    this.ends.array[i * 2 + 1] = target;
  }

  /**
   * Colour with the intensity at the source (`head`) and at the target (`tail`), the width in pixels, and
   * the flow: 0 a steady ribbon, 1 bright dashes running along it.
   */
  setStyle(i, color, head, tail, width, flow = 0) {
    const c = this.colors.array;
    c[i * 3] = color.r;
    c[i * 3 + 1] = color.g;
    c[i * 3 + 2] = color.b;
    this.intensity.array[i * 2] = head;
    this.intensity.array[i * 2 + 1] = tail;
    this.widths.array[i] = width;
    if (flow > 0 !== this.flows.array[i] > 0) this.flowing += flow > 0 ? 1 : -1;
    this.flows.array[i] = flow;
  }

  /**
   * The wave of light after a click: how many hops from the selected unit the link's source and target are
   * (-1: the wave does not pass). Clear all with clearWaves(), then upload with flush().
   */
  setWave(i, sourceHop, targetHop) {
    this.waves.array[i * 2] = sourceHop;
    this.waves.array[i * 2 + 1] = targetHop;
  }

  clearWaves() {
    this.waves?.array.fill(-1);
  }

  /** Uploads everything (after setCount / a full restyle). */
  flush() {
    for (const attr of [this.ends, this.colors, this.intensity, this.widths, this.flows, this.waves]) uploadAll(attr);
  }

  /** Uploads the style of a few links only (hover). */
  flushStyle(indices) {
    for (const [attr, size] of [[this.colors, 3], [this.intensity, 2], [this.widths, 1], [this.flows, 1]]) {
      for (const i of indices) uploadRange(attr, i * size, size);
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/** A strip along t = 0..1 with two vertices (sides -1, +1) per step. */
function stripGeometry(segments) {
  const n = segments + 1;
  const t = new Float32Array(n * 2);
  const side = new Float32Array(n * 2);
  const index = [];
  for (let i = 0; i < n; i++) {
    t[i * 2] = t[i * 2 + 1] = i / segments;
    side[i * 2] = -1;
    side[i * 2 + 1] = 1;
    if (i < segments) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(n * 2 * 3), 3)); // unused, required
  geometry.setAttribute('aT', new BufferAttribute(t, 1));
  geometry.setAttribute('aSide', new BufferAttribute(side, 1));
  geometry.setIndex(index);
  return geometry;
}

/** Point on a link at t: straight, or a quadratic arc that rises with the distance (code city). */
export function linkPoint(p0, p1, t, arc) {
  if (!arc) return mix(p0, p1, t);
  const mid = p0.add(p1).mul(0.5);
  const control = vec3(mid.x, max(p0.y, p1.y).add(12).add(distance(p0, p1).mul(0.42)), mid.z);
  const u = float(1).sub(t);
  return p0.mul(u.mul(u)).add(control.mul(u.mul(t).mul(2))).add(p1.mul(t.mul(t)));
}

function linkMaterial(store, { arc, segments }) {
  // Double-sided: which way a ribbon's triangles wind depends on the link's direction on screen.
  const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending, fog: false, side: DoubleSide });
  const ends = attribute('aEnds', 'vec2');
  const t = attribute('aT', 'float');
  const side = attribute('aSide', 'float');
  const width = attribute('aWidth', 'float');
  const vSide = varying(side, 'vLinkSide');
  const vT = varying(t, 'vLinkT');

  // Clip-space position, built from plain expressions (no Fn: an inline Fn cannot return a value).
  const p0 = store.positionAt(ends.x).xyz;
  const p1 = store.positionAt(ends.y).xyz;
  const mvp = cameraProjectionMatrix.mul(modelViewMatrix);
  let clip;
  let a;
  let b;
  let behind;
  let ends2d; // the link's two ends on screen (for its length)
  const onScreen = (c) => c.xy.div(max(c.w, NEAR_W)).mul(viewportSize);
  if (!arc) {
    // Straight: clip the segment at the near plane, so a link reaching behind the camera stays drawn.
    const c0 = mvp.mul(vec4(p0, 1));
    const c1 = mvp.mul(vec4(p1, 1));
    const w0 = c0.w;
    const w1 = c1.w;
    a = select(w0.lessThan(NEAR_W), mix(c0, c1, float(NEAR_W).sub(w0).div(w1.sub(w0))), c0);
    b = select(w1.lessThan(NEAR_W), mix(c1, c0, float(NEAR_W).sub(w1).div(w0.sub(w1))), c1);
    behind = max(w0, w1).lessThan(NEAR_W);
    clip = mix(a, b, t);
    ends2d = [a, b];
  } else {
    const step = 0.5 / segments;
    clip = mvp.mul(vec4(linkPoint(p0, p1, t, true), 1));
    a = mvp.mul(vec4(linkPoint(p0, p1, max(t.sub(step), 0), true), 1));
    b = mvp.mul(vec4(linkPoint(p0, p1, min(t.add(step), 1), true), 1));
    // Arc vertices behind the camera are dropped (the city is seen from above).
    behind = clip.w.lessThan(NEAR_W);
    ends2d = [mvp.mul(vec4(p0, 1)), mvp.mul(vec4(p1, 1))];
  }

  // Direction on screen, and the ribbon's sideways offset in pixels.
  const sa = onScreen(a);
  const sb = onScreen(b);
  const direction = normalize(sb.sub(sa).add(vec2(1e-6, 0)));
  const normal = vec2(direction.y.negate(), direction.x);
  const offset = normal.mul(side).mul(width).mul(screenDPR).div(viewportSize).mul(2);
  material.vertexNode = select(behind, vec4(0, 0, 2, 1), vec4(clip.xy.add(offset.mul(clip.w)), clip.z, clip.w));

  const edge = float(1).sub(smoothstep(0.25, 1, abs(vSide)));
  const intensity = mix(attribute('aIntensity', 'vec2').x, attribute('aIntensity', 'vec2').y, vT);
  // Dashes: the link's length on screen in CSS pixels (onScreen gives twice the device pixels; an arc is
  // a bit longer than its chord), and the dash pattern moving towards the target.
  const length = distance(onScreen(ends2d[0]), onScreen(ends2d[1])).div(screenDPR.mul(2)).mul(arc ? 1.3 : 1);
  const vLength = varying(length, 'vLinkLength');
  const vFlow = varying(attribute('aFlow', 'float'), 'vLinkFlow');
  const phase = fract(vT.mul(vLength).div(DASH).sub(time.mul(DASH_SPEED)));
  const dash = smoothstep(0, 0.2, phase).mul(float(1).sub(smoothstep(0.45, 0.65, phase)));
  const flow = mix(float(1), dash.mul(1.6).add(0.3), vFlow);
  // The wave: a pulse of light at `waveFront` hops from the selection, running along the link outwards.
  const waveFront = uniform(-100);
  material.userData.waveFront = waveFront;
  const vWave = varying(attribute('aWave', 'vec2'), 'vLinkWave');
  const along = mix(vWave.x, vWave.y, vT).sub(waveFront);
  const pulse = select(vWave.x.greaterThanEqual(0), exp(along.mul(along).mul(-12)), float(0));
  const base = attribute('aColor', 'vec3').mul(intensity).mul(flow);
  material.colorNode = vec4(base.mul(pulse.mul(2.5).add(1)).add(vec3(pulse.mul(0.5))).mul(edge), 1);
  return material;
}
