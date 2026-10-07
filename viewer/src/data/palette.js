import { Color } from 'three';

export const KIND_COLORS = {
  project: '#e8eeff',
  package: '#a1887f',
  assembly: '#8d6e63',
  namespace: '#90a4ae',
  class: '#4f8ef7',
  interface: '#35c9a5',
  struct: '#f5a524',
  record: '#b07cf7',
  recordStruct: '#d4a6ff',
  enum: '#f06292',
  delegate: '#bdbdbd',
  method: '#ffb74d',
  constructor: '#ff8a65',
  property: '#81c784',
  field: '#4dd0e1',
  event: '#e57373',
};

export const EDGE_KINDS = {
  calls: { color: '#ffb74d', label: 'calls', on: true, hint: 'method → method' },
  inherits: { color: '#5c9dff', label: 'inherits', on: true, hint: 'base class / interface' },
  implements: { color: '#35c9a5', label: 'implements', on: true, hint: 'interface implementation' },
  injects: { color: '#c77dff', label: 'injects', on: true, hint: 'constructor dependency (DI)' },
  instantiates: { color: '#ff6e6e', label: 'instantiates', on: true, hint: 'new T()' },
  holds: { color: '#7bd88f', label: 'holds', on: true, hint: 'field / property of type' },
  subscribes: { color: '#ff7eb6', label: 'subscribes', on: true, hint: 'event += handler' },
  throws: { color: '#ff4d4d', label: 'throws', on: true, hint: 'throw new T()' },
  overrides: { color: '#8c9eff', label: 'overrides', on: false, hint: 'override of a base member' },
  extends: { color: '#ffd54f', label: 'extends', on: true, hint: 'extension method target' },
  accesses: { color: '#4dd0e1', label: 'accesses', on: false, hint: 'reads / writes a field or property' },
  uses: { color: '#9fb3c8', label: 'uses', on: false, hint: 'any other type reference' },
  returns: { color: '#b2e07a', label: 'returns', on: false, hint: 'return type' },
  accepts: { color: '#e0e57a', label: 'accepts', on: false, hint: 'parameter type' },
  catches: { color: '#ffab91', label: 'catches', on: false, hint: 'catch (T)' },
  decoratedWith: { color: '#bcaaa4', label: 'decorated with', on: false, hint: '[Attribute]' },
  projectReference: { color: '#cfd8dc', label: 'project reference', on: true, hint: '<ProjectReference>' },
  packageReference: { color: '#a1887f', label: 'package reference', on: false, hint: '<PackageReference>' },
  changesWith: { color: '#ffd166', label: 'changes with (git)', on: false, hint: 'modified in the same commits – not a code dependency' },
};

export const TAG_COLORS = {
  controller: '#ff7043',
  test: '#66bb6a',
  dbcontext: '#ffa726',
  repository: '#29b6f6',
  service: '#5c6bc0',
  handler: '#ab47bc',
  'hosted-service': '#26a69a',
  middleware: '#ec407a',
  exception: '#ef5350',
  extensions: '#ffee58',
  options: '#8d6e63',
  dto: '#78909c',
  validator: '#9ccc65',
  factory: '#7e57c2',
  entrypoint: '#ffffff',
  attribute: '#bcaaa4',
  hub: '#26c6da',
};

const tmp = new Color();

/** Distinct, pleasant hues for projects (golden angle spacing). */
export function projectColor(index) {
  const hue = ((index * 137.508 + 210) % 360) / 360;
  return new Color().setHSL(hue, 0.72, 0.62);
}

/** Slight variation of a base colour for children (namespaces inside a project...). */
export function vary(base, index, amount = 0.07) {
  const hsl = {};
  base.getHSL(hsl);
  const offset = ((index * 0.618034) % 1) - 0.5;
  return new Color().setHSL((hsl.h + offset * amount + 1) % 1, hsl.s, Math.min(0.78, Math.max(0.45, hsl.l + offset * 0.18)));
}

/** Google "Turbo" colormap, polynomial approximation. t in [0,1]. */
export function turbo(t, target = new Color()) {
  t = Math.min(1, Math.max(0, t));
  const r = 0.13572138 + t * (4.6153926 + t * (-42.66032258 + t * (132.13108234 + t * (-152.94239396 + t * 59.28637943))));
  const g = 0.09140261 + t * (2.19418839 + t * (4.84296658 + t * (-14.18503333 + t * (4.27729857 + t * 2.82956604))));
  const b = 0.1066733 + t * (12.64194608 + t * (-60.58204836 + t * (110.36276771 + t * (-89.90310912 + t * 27.34824973))));
  return target.setRGB(Math.min(1, Math.max(0, r)), Math.min(1, Math.max(0, g)), Math.min(1, Math.max(0, b)));
}

export function turboCss(t) {
  return '#' + turbo(t, tmp).getHexString();
}

export function edgeColor(kind) {
  return new Color(EDGE_KINDS[kind]?.color ?? '#9fb3c8');
}
