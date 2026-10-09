import { DataTexture, FloatType, NearestFilter, RGBAFormat } from 'three/webgpu';
import { int, ivec2, texture } from 'three/tsl';

/** Positions per texture row: 1024 × 1024 positions fit the smallest texture limit every GPU has (8192). */
const WIDTH = 1024;

/**
 * Where every unit is, on the GPU: one texel (x, y, z, w) per unit in a float texture. Node, link and
 * particle shaders read their positions from it by unit index, so a moving layout uploads one texture per
 * frame instead of rewriting every instance matrix and every link vertex. The same texture works on the
 * WebGPU and the WebGL 2 backend.
 */
export class PositionStore {
  constructor(capacity = WIDTH) {
    this.rows = 0;
    this.node = null;
    this.ensure(capacity);
  }

  /** Room for at least `count` units; grows (never shrinks), and shaders built on the store follow. */
  ensure(count) {
    const rows = Math.max(1, Math.ceil(count / WIDTH));
    if (rows <= this.rows) return;
    // Some headroom, so a slightly bigger graph does not reallocate.
    this.rows = Math.max(rows, Math.ceil(this.rows * 1.5));
    const data = new Float32Array(WIDTH * this.rows * 4);
    if (this.data) data.set(this.data.subarray(0, Math.min(this.data.length, data.length)));
    const next = new DataTexture(data, WIDTH, this.rows, RGBAFormat, FloatType);
    next.magFilter = next.minFilter = NearestFilter;
    next.generateMipmaps = false;
    next.needsUpdate = true;
    this.texture?.dispose();
    this.texture = next;
    this.data = data;
    if (this.node) this.node.value = next; // a GPU layout writing its own texture is restarted with the new size
    else this.node = texture(next);
  }

  get capacity() {
    return WIDTH * this.rows;
  }

  set(i, x, y, z, w = 1) {
    const d = this.data;
    d[i * 4] = x;
    d[i * 4 + 1] = y;
    d[i * 4 + 2] = z;
    d[i * 4 + 3] = w;
  }

  /** Copies a flat x, y, z array (a layout's positions) into the store. */
  setAll(positions, count) {
    const d = this.data;
    for (let i = 0; i < count; i++) {
      d[i * 4] = positions[i * 3];
      d[i * 4 + 1] = positions[i * 3 + 1];
      d[i * 4 + 2] = positions[i * 3 + 2];
    }
  }

  /** Sends the positions to the GPU with the next frame (and shows them again, if a GPU layout wrote its own). */
  upload() {
    if (this.node.value !== this.texture) this.node.value = this.texture;
    this.texture.needsUpdate = true;
  }

  /**
   * Draws from a texture the GPU writes itself (the compute layout's storage texture, same size) until the
   * next upload(); the CPU copy (`data`) is kept in step by whoever writes it.
   */
  useTexture(texture) {
    this.node.value = texture;
  }

  /** Shader node: the stored position (vec4) of the unit with the given index (a float or int node). */
  positionAt(indexNode) {
    const i = int(indexNode);
    return this.node.load(ivec2(i.mod(WIDTH), i.div(WIDTH)));
  }

  dispose() {
    this.texture?.dispose();
  }
}
