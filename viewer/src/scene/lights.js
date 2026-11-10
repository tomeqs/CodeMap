import { AmbientLight, DirectionalLight, HemisphereLight, PointLight } from 'three/webgpu';

/**
 * The lights of every view: one set, always in the scene. three builds the lights into the shaders (their ids
 * are part of the shader key), so when each view brought lights of its own, every view switch compiled the
 * shaders of all lit materials again – a stall of a second or more in the editor, every time, also back to a
 * view already seen. Views only set colours, intensities and where the lights stand. A light a view does not
 * use goes dark (intensity 0) rather than hidden: hiding it would change the shaders as well.
 */
export class Lights {
  constructor(scene) {
    this.ambient = new AmbientLight(0xffffff, 0);
    this.hemisphere = new HemisphereLight(0xffffff, 0x000000, 0);
    // The city's sun casts shadows; the shadow setting is part of the shader key too, so it stays on (nothing
    // receives shadows in the other views, so they draw no shadow map).
    this.sun = new DirectionalLight(0xffffff, 0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0005;
    this.point = new PointLight(0xffffff, 0, 0, 0);
    scene.add(this.ambient, this.hemisphere, this.sun, this.sun.target, this.point);
  }

  /**
   * A view's lighting: ambient { color, intensity }, hemisphere { sky, ground, intensity }, sun and point
   * { color, intensity, position? } (the sun looks at the origin). Lights not given go dark.
   */
  set({ ambient, hemisphere, sun, point } = {}) {
    this.ambient.color.set(ambient?.color ?? 0xffffff);
    this.ambient.intensity = ambient?.intensity ?? 0;
    this.hemisphere.color.set(hemisphere?.sky ?? 0xffffff);
    this.hemisphere.groundColor.set(hemisphere?.ground ?? 0x000000);
    this.hemisphere.intensity = hemisphere?.intensity ?? 0;
    this.sun.color.set(sun?.color ?? 0xffffff);
    this.sun.intensity = sun?.intensity ?? 0;
    if (sun?.position) this.sun.position.copy(sun.position);
    this.sun.target.position.set(0, 0, 0);
    this.point.color.set(point?.color ?? 0xffffff);
    this.point.intensity = point?.intensity ?? 0;
    if (point?.position) this.point.position.copy(point.position);
  }
}
