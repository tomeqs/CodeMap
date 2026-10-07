/** Lifetimes from the longest-lived (bottom plane) to "not registered" (top plane). */
export const LIFETIMES = [
  { id: 'singleton', title: 'Singleton', color: '#b388ff', note: 'one instance for the whole app' },
  { id: 'scoped', title: 'Scoped', color: '#4fc3f7', note: 'one instance per request / scope' },
  { id: 'transient', title: 'Transient', color: '#7bd88f', note: 'a new instance every time' },
  { id: 'missing', title: 'Not registered', color: '#ff7043', note: 'nothing registers this service' },
];

export const LIFETIME_COLORS = Object.fromEntries(LIFETIMES.map((l) => [l.id, l.color]));

/**
 * Builds the DI view: every type the container constructs (or that the framework activates, like
 * controllers), on the plane of its lifetime, linked to the implementations it receives. A healthy
 * dependency points down or sideways (to something living at least as long); captive dependencies
 * and missing registrations point up and are flagged.
 */
export function buildDiGraph(model, state) {
  const di = model.doc.analysis?.di;
  if (!di) return null;

  const lifetimeOf = new Map();
  for (const r of di.registrations) {
    const id = r.implementation ?? (r.external ? null : r.service);
    if (id && model.get(id) && !lifetimeOf.has(id)) lifetimeOf.set(id, r.lifetime);
  }

  for (const d of di.dependencies) {
    if (model.get(d.consumer) && !lifetimeOf.has(d.consumer)) lifetimeOf.set(d.consumer, d.consumerLifetime);
  }

  const issues = new Map(di.issues.map((i) => [`${i.consumer}|${i.service}`, i]));
  const links = new Map();
  for (const d of di.dependencies) {
    if (d.external || !model.get(d.consumer)) continue;
    const missing = d.implementations.length === 0;
    if (missing && (d.optional || d.many)) continue;
    const targets = missing ? [d.service] : d.implementations;
    for (const target of targets) {
      if (!model.get(target)) continue;
      if (!lifetimeOf.has(target)) lifetimeOf.set(target, missing ? 'missing' : d.lifetime ?? 'transient');
      const issue = issues.get(`${d.consumer}|${d.service}`);
      const targetLifetime = lifetimeOf.get(target);
      let violation = null;
      if (issue?.kind === 'unregistered') violation = 'warning';
      else if (issue?.kind === 'captive' && targetLifetime === 'scoped') violation = 'error';
      else if (issue?.kind === 'captive-transient' && targetLifetime === 'transient') violation = 'warning';

      const key = d.consumer + '\u0000' + target;
      const existing = links.get(key);
      if (existing) {
        existing.weight++;
        if (violation === 'error' || (violation && !existing.violation)) existing.violation = violation;
        continue;
      }

      links.set(key, { source: d.consumer, target, weight: 1, kind: 'injects', kinds: { injects: 1 }, violation, service: d.service, issue });
    }
  }

  const units = [...lifetimeOf.keys()]
    .map((id) => model.get(id))
    .filter((n) => n && (state.showTests || !n.isTest) && !state.hiddenProjects?.has(n.projectNode?.id));
  const visible = new Set(units.map((u) => u.id));
  const present = LIFETIMES.filter((l) => units.some((u) => lifetimeOf.get(u.id) === l.id));
  const indexOf = new Map(present.map((l, i) => [l.id, i]));
  const layerOf = new Map(units.map((u) => [u.id, indexOf.get(lifetimeOf.get(u.id)) ?? 0]));
  const layers = present.map((l) => {
    const count = units.filter((u) => lifetimeOf.get(u.id) === l.id).length;
    return { title: `${l.title} · ${count}`, color: l.color, id: l.id };
  });

  const linkList = [...links.values()].filter((l) => visible.has(l.source) && visible.has(l.target));
  return {
    units,
    links: linkList,
    layering: { layerOf, layers },
    lifetimeOf,
    stats: {
      services: units.length,
      errors: di.issues.filter((i) => i.severity === 'error').length,
      warnings: di.issues.filter((i) => i.severity !== 'error').length,
    },
  };
}
