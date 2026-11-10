import { InstancedMesh } from 'three';

/**
 * An instanced mesh of `count` instances in `group`: `old` again when it has room for them (same geometry and
 * material), else a new one in its place. three builds an instanced mesh's own buffers into its shaders, so a
 * new mesh means new shaders to compile – every time a view was built again (back to the city, another level),
 * a stall of up to a second. Reused, it draws with the shaders it already has.
 */
export function instances(group, old, geometry, material, count) {
  if (old && old.geometry === geometry && old.material === material && old.instanceMatrix.count >= count) {
    old.count = count;
    return old;
  }

  if (old) {
    group.remove(old);
    old.dispose();
  }

  const mesh = new InstancedMesh(geometry, material, Math.max(1, count));
  mesh.count = count;
  group.add(mesh);
  return mesh;
}
