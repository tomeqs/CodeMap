import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

/**
 * An Unreal Engine module: the folder of its Name.Build.cs, which names the modules it depends on
 * (PublicDependencyModuleNames / PrivateDependencyModuleNames, with AddRange or Add). Engine modules (Core,
 * Engine…) are libraries; the project's own modules are projects.
 */
export function readBuildCs(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  // Without its comments: the engine's template lists modules to add in commented-out lines.
  text = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, '');
  const dependencies = [];
  const re = /(Public|Private)DependencyModuleNames\s*\.\s*(AddRange\s*\(\s*new\s+string\s*\[\s*\]\s*\{([^}]*)\}|Add\s*\(\s*"([^"]+)"\s*\))/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[3] !== undefined) dependencies.push(...[...m[3].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
    else if (m[4]) dependencies.push(m[4]);
  }

  return { name: basename(file).replace(/\.Build\.cs$/i, ''), file, dir: dirname(file), dependencies: [...new Set(dependencies)] };
}
