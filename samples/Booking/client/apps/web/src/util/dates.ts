/** Reached through the tsconfig alias `@/util/dates`. */
export function formatNights(nights: number): string {
  return nights === 1 ? '1 night' : `${nights} nights`;
}
