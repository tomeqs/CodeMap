export async function listOrders(req: unknown, res: { json(v: unknown): void }) {
  res.json(await getOrder('all'));
}

export async function getOrder(id: string) {
  return id === 'none' ? undefined : { id };
}

export function addLine(id: string, line: unknown) {
  return { id, line };
}
