/** Base of the clients of the C# Booking.Api. Edge case: subclasses in other packages call this constructor with super(). */
export class HttpClient {
  constructor(protected readonly baseUrl: string) {}

  protected async get<T>(path: string): Promise<T> {
    return this.send<T>('GET', path);
  }

  protected async post<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>('POST', path, body);
  }

  protected async delete(path: string): Promise<void> {
    await this.send<void>('DELETE', path);
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(this.baseUrl + path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  }
}
