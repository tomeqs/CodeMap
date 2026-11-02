/** The NestJS API behind the gateway. */
export class ApiClient {
  constructor(private readonly baseUrl: string) {}

  async get<T>(path: string): Promise<T | undefined> {
    const response = await fetch(this.baseUrl + path);
    return response.ok ? ((await response.json()) as T) : undefined;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(this.baseUrl + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return (await response.json()) as T;
  }
}

export const api = new ApiClient(process.env.API_URL ?? 'http://localhost:3000');
