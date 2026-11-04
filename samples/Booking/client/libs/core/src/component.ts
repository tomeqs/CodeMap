export interface ComponentOptions {
  selector: string;
  template: string;
}

const registry = new Map<string, Function>();

/** A small UI decorator. Edge case: its template argument holds parentheses, which must not end up in signatures. */
export function component(options: ComponentOptions) {
  return <T extends Function>(target: T): T => {
    registry.set(options.selector, target);
    return target;
  };
}

export function componentFor(selector: string): Function | undefined {
  return registry.get(selector);
}
