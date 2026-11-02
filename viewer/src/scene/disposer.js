/**
 * Frees the GPU resources (geometries, materials, their textures, instance buffers) of an object tree.
 * Shared geometries and textures may be freed too: three uploads them again the next time they are drawn.
 */
export function disposeObject(root) {
  const seen = new Set();
  const free = (resource) => {
    if (!resource || seen.has(resource)) return;
    seen.add(resource);
    resource.dispose?.();
  };

  root.traverse((object) => {
    if (object.isInstancedMesh) object.dispose(); // instance matrices and colours
    free(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!material) continue;
      for (const value of Object.values(material)) if (value?.isTexture) free(value);
      free(material);
    }

    if (object.isLight && object.shadow?.map) object.shadow.dispose();
  });
}
