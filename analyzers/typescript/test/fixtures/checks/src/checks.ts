export async function load(): Promise<number> {
  return 1;
}

export function exceptions(log: (m: string) => void) {
  try { load(); } catch { }
  try { load(); } catch { /* best effort: the cache is optional */ }
  try { log('x'); } catch (e) { log(String(e)); }
  try { log('y'); } catch { log('cleanup'); }
  try { log('z'); } catch (e) { const ignored = 1; return ignored; }
}

export async function promises(items: number[]) {
  load();
  void load();
  load().catch(() => 0);
  await load();
  if (load()) return 1;
  if (!load()) return 2;
  items.forEach(async (i) => { await load(); return i; });
  for (const i of items) await load();
  return new Promise(async (resolve) => resolve(await load()));
}

export function flow(x: number, s: string) {
  if (x > 1) {
    return 1;
    console.log('never');
  }

  let y = x;
  y = y;
  if (x === x) return 2;
  if (x !== x) return 3; // a NaN check
  switch (s) {
    case 'a': return 4;
    case 'b': return 5;
    case 'a': return 6;
  }

  if (true) return 7;
  while (true) { break; } while (1) { break; }
  if ((x as unknown) == '1') return 8;
  if (s == null) return 9;
  const n: number | null = Math.random() > 0.5 ? null : 1;
  if (s === 1) return 10;
  return n.toFixed();
}

function unusedHelper() { return 1; }
