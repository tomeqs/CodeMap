/**
 * How the map moves when nobody touches it:
 *   living – always, at the display's rate (twinkling sky, flowing links, breathing glow)
 *   calm   – decoration at 30 fps that stops 20 s after the last input (battery)
 *   off    – nothing moves by itself
 * The choice is remembered in the browser; without one the stage picks (see Stage.motion).
 */
export const MOTIONS = ['living', 'calm', 'off'];
const KEY = 'codemap.motion';

/** The motion the user chose, or null. `?motion=` overrides it for tests and benchmarks. */
export function storedMotion() {
  const param = new URLSearchParams(globalThis.location?.search ?? '').get('motion');
  if (MOTIONS.includes(param)) return param;
  try {
    const stored = localStorage.getItem(KEY);
    return MOTIONS.includes(stored) ? stored : null;
  } catch {
    return null; // storage blocked (some webviews, private modes)
  }
}

export function rememberMotion(value) {
  try {
    if (MOTIONS.includes(value)) localStorage.setItem(KEY, value);
    else localStorage.removeItem(KEY);
  } catch {
    // not remembered; still applies for this session
  }
}
