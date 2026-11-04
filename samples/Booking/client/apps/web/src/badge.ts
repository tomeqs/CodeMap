/** Something with a label: only the constraint of Renderer's type parameter names it. */
interface Labelled {
  label: string;
}

/** Only the annotation of Badge and the default of Renderer's type parameter name it. */
interface BadgeProps {
  label: string;
  tone: 'info' | 'warn';
}

/** Edge case: a type parameter with a constraint and a default; Renderer uses both. */
export type Renderer<P extends Labelled = BadgeProps> = (props: P) => HTMLElement;

/** Edge case: a function typed by its variable's annotation; Badge uses Renderer and BadgeProps. */
export const Badge: Renderer<BadgeProps> = (props) => {
  const badge = document.createElement('span');
  badge.textContent = props.label;
  badge.dataset.tone = props.tone;
  return badge;
};
