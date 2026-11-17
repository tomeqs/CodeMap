import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, normalize, resolve } from 'node:path';

/**
 * Visual Studio C++ projects (.vcxproj) and the solutions that list them. Read as text: the items it compiles
 * (ClCompile) and includes (ClInclude), the projects it references, its include directories (with
 * $(ProjectDir) and $(SolutionDir) expanded, other macros dropped) and whether it builds a program.
 */
export function readVcxproj(file, solutionDir = null) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  const dir = dirname(file);
  const name = tag(text, 'ProjectName') ?? basename(file).replace(/\.vcxproj$/i, '');
  const items = (kind) => [...text.matchAll(new RegExp(`<${kind}\\s+Include="([^"]+)"`, 'g'))].map((m) => m[1]);
  const macros = (value) => value
    .replace(/\$\(ProjectDir\)/gi, dir + '/')
    .replace(/\$\(MSBuildProjectDirectory\)/gi, dir)
    .replace(/\$\(SolutionDir\)/gi, (solutionDir ?? dir) + '/');
  const toPath = (value) => {
    const expanded = macros(value).replace(/\\/g, '/');
    if (expanded.includes('$(') || expanded.includes('%(')) return null;
    return normalize(isAbsolute(expanded) ? expanded : resolve(dir, expanded));
  };

  const includeDirs = [...text.matchAll(/<AdditionalIncludeDirectories>([^<]*)<\/AdditionalIncludeDirectories>/g)]
    .flatMap((m) => m[1].split(';'))
    .map((d) => d.trim())
    .filter(Boolean)
    .map(toPath)
    .filter(Boolean);
  const type = tag(text, 'ConfigurationType');
  return {
    name,
    file,
    dir,
    sources: [...items('ClCompile'), ...items('ClInclude')].map(toPath).filter(Boolean),
    references: items('ProjectReference').map(toPath).filter(Boolean),
    includeDirs: [...new Set(includeDirs)],
    executable: type === 'Application',
    configurationType: type,
  };
}

/** The .vcxproj projects a solution (.sln or .slnx) lists. */
export function solutionProjects(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const dir = dirname(file);
  const paths = /\.slnx$/i.test(file)
    ? [...text.matchAll(/<Project\s+Path="([^"]+)"/g)].map((m) => m[1])
    : [...text.matchAll(/^Project\("\{[^}]+\}"\)\s*=\s*"[^"]*",\s*"([^"]+)"/gm)].map((m) => m[1]);
  return paths
    .filter((p) => /\.vcxproj$/i.test(p))
    .map((p) => normalize(resolve(dir, p.replace(/\\/g, '/'))))
    .filter((p) => existsSync(p));
}

function tag(text, name) {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(text);
  return m ? m[1].trim() : null;
}
