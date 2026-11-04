import { WebGPURenderer } from 'three/webgpu';

/**
 * Which backend to use: `?renderer=webgl|webgpu`, a <meta name="codemap-renderer"> set by the host
 * (VS Code setting), or what the user picked last in the Data tab. Default: WebGPU where available.
 */
export function rendererPreference() {
  const fromUrl = new URLSearchParams(location.search).get('renderer');
  const fromHost = document.querySelector('meta[name="codemap-renderer"]')?.getAttribute('content');
  let stored = null;
  try {
    stored = localStorage.getItem('codemap.renderer');
  } catch {
    // storage blocked: no remembered choice
  }

  const value = fromUrl ?? (fromHost && fromHost !== 'auto' ? fromHost : null) ?? stored;
  return value === 'webgl' || value === 'webgpu' ? value : 'auto';
}

export function rememberRenderer(value) {
  try {
    if (value === 'auto') localStorage.removeItem('codemap.renderer');
    else localStorage.setItem('codemap.renderer', value);
  } catch {
    // storage blocked
  }
}

/**
 * The WebGPU device, asked for with the adapter's own limits (big storage buffers for large graphs), or
 * null when there is no WebGPU here (old browser, Linux without the flag, a page that is not a secure context).
 */
async function requestDevice() {
  if (typeof navigator === 'undefined' || !navigator.gpu) return null;
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return null;
    const limits = {};
    for (const name of ['maxStorageBufferBindingSize', 'maxBufferSize', 'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup', 'maxComputeWorkgroupSizeX', 'maxStorageBuffersPerShaderStage']) {
      if (adapter.limits[name] !== undefined) limits[name] = adapter.limits[name];
    }

    const device = await adapter.requestDevice({ requiredFeatures: [...adapter.features], requiredLimits: limits });
    const info = adapter.info ?? {};
    const software = !!(info.isFallbackAdapter ?? adapter.isFallbackAdapter) || /swiftshader|llvmpipe|software/i.test(`${info.vendor} ${info.architecture} ${info.description}`);
    // Keep the adapter referenced as long as the device: Chrome may lose a device whose adapter was collected.
    return { adapter, device, software, name: [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || 'WebGPU adapter' };
  } catch (error) {
    console.warn('CodeMap: no WebGPU device, using WebGL 2.', error);
    return null;
  }
}

/**
 * Whether this page can have a WebGL 2 context. Without a usable GPU, recent Chromium (and the editors built on it:
 * VS Code, Cursor) no longer falls back to software WebGL, while it may still offer a software WebGPU adapter.
 */
function hasWebGL2() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext(); // give the context back at once
    return !!gl;
  } catch {
    return false;
  }
}

/** Neither WebGPU nor WebGL 2: the map cannot be drawn here (see showStartupError in main.js). */
export class NoGraphicsError extends Error {
  constructor() {
    super('Neither WebGPU nor WebGL 2 is available here.');
    this.name = 'NoGraphicsError';
    this.code = 'no-graphics';
  }
}

/**
 * Creates and initializes the renderer: WebGPU (Metal on macOS, Direct3D 12 on Windows, Vulkan on Linux)
 * when possible, WebGL 2 otherwise. A preferred backend that is not available gives way to the other one.
 * Resolves to { renderer, backend: 'webgpu' | 'webgl', adapter, software }.
 */
export async function createRenderer(canvasOptions = {}) {
  const preference = rendererPreference();
  const webgl = hasWebGL2();
  let gpu = preference === 'webgl' && webgl ? null : await requestDevice();
  // Without a GPU (a software WebGPU adapter) WebGL 2 on SwiftShader is the faster of the two, when there is one.
  if (gpu?.software && preference === 'auto' && webgl) {
    gpu.device.destroy();
    gpu = null;
  }

  if (!gpu && !webgl) throw new NoGraphicsError();
  if (preference === 'webgl' && gpu) console.warn('CodeMap: no WebGL 2 here, using WebGPU.');

  const renderer = new WebGPURenderer({
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    ...(gpu ? { device: gpu.device } : { forceWebGL: true }),
    ...canvasOptions,
  });
  await renderer.init();
  // init() starts three's own requestAnimationFrame loop; the stage draws on demand instead (see beginFrame).
  renderer._animation?.stop();
  const backend = renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl';
  let adapter = gpu?.name ?? 'WebGL 2';
  if (backend === 'webgl') {
    const gl = renderer.backend.gl;
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    if (debug) adapter = gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);
  }

  const software = backend === 'webgpu' ? !!gpu?.software : /swiftshader|llvmpipe|software/i.test(adapter);
  renderer.userData = { gpuAdapter: gpu?.adapter ?? null };
  return { renderer, backend, adapter, software, preference };
}

/**
 * What three's own animation loop does before every frame (the stage replaced it): per-frame counters and
 * node uniforms such as time.
 */
export function beginFrame(renderer) {
  const info = renderer.info;
  if (info.autoReset) info.reset();
  const nodes = renderer._nodes;
  if (nodes) {
    nodes.nodeFrame.update();
    info.frame = nodes.nodeFrame.frameId;
  }
}
