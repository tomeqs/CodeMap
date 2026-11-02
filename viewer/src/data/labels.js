/**
 * What the map calls its levels and the code outside the analysis, from the languages the graph lists
 * (source.languages): Projects / Namespaces / Types / Members for C#, Packages / Folders / Files / Declarations
 * for TypeScript; a map of several languages joins their words ("Projects / Packages"). Older files have no list
 * and get C#'s words.
 */
const LEVEL_KEYS = ['project', 'namespace', 'type', 'member'];
const CSHARP = {
  project: ['Project', 'Projects'],
  namespace: ['Namespace', 'Namespaces'],
  type: ['Type', 'Types'],
  member: ['Member', 'Members'],
  external: 'BCL / NuGet',
};

export function levelLabels(doc) {
  const languages = (doc?.source?.languages ?? []).filter((l) => l && typeof l === 'object');
  if (!languages.length) return CSHARP;
  const result = {};
  for (const level of LEVEL_KEYS) {
    const names = languages.map((l) => l.levels?.[level]).filter((n) => Array.isArray(n) && n.length === 2);
    const distinct = (i) => [...new Set(names.map((n) => n[i]))].join(' / ');
    result[level] = names.length ? [distinct(0), distinct(1)] : CSHARP[level];
  }

  result.external = [...new Set(languages.map((l) => l.external).filter(Boolean))].join(' / ') || CSHARP.external;
  return result;
}
