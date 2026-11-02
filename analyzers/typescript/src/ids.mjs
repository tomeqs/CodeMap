/**
 * Node ids. They depend only on paths and names, so the same code gets the same ids whatever was analyzed
 * with it (one package or the whole monorepo), and a declaration can be named without its program.
 */
export const projectId = (project) => `ts:project:${project}`;
export const folderId = (project, folder) => `ts:ns:${project}/${folder}`;
export const moduleId = (project, path) => `ts:${project}:${path}`;
export const memberId = (module, name) => `${module}#${name}`;
export const packageId = (name) => `ts:npm:${name}`;

/** The npm package a bare import names: `lodash/fp` → `lodash`, `@nestjs/common/x` → `@nestjs/common`. */
export function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}
