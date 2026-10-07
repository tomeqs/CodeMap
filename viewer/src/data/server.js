/**
 * Talks to the local `codemap` server (codemap ui). The session token comes from the page the
 * server rendered; every API call sends it back so other web sites cannot use the API.
 */
export class ServerClient {
  constructor(config) {
    this.config = config;
    this.token = config.token;
  }

  /** Server mode is on when the server injected its config, or (dev) when ?token= is in the URL. */
  static detect() {
    const injected = document.getElementById('codemap-server')?.textContent?.trim();
    if (injected) {
      try {
        return new ServerClient(JSON.parse(injected));
      } catch {
        return null;
      }
    }

    const token = new URLSearchParams(location.search).get('token');
    return token ? new ServerClient({ token }) : null;
  }

  async request(method, path, body) {
    const response = await fetch(path, {
      method,
      headers: { 'X-CodeMap-Token': this.token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      try {
        message = (await response.json()).error ?? message;
      } catch {
        // not JSON
      }

      throw new Error(message);
    }

    if (response.status === 204) return null;
    return response.json();
  }

  get(path) {
    return this.request('GET', path);
  }

  post(path, body = {}) {
    return this.request('POST', path, body);
  }

  delete(path) {
    return this.request('DELETE', path);
  }

  browse(path) {
    return this.get('/api/browse' + (path ? '?path=' + encodeURIComponent(path) : ''));
  }

  /** Subscribes to server-sent events; returns a function that closes the stream. */
  connect(onEvent) {
    const source = new EventSource('/api/events?token=' + encodeURIComponent(this.token));
    source.onopen = () => onEvent({ type: 'connected' });
    source.onmessage = (e) => {
      try {
        onEvent(JSON.parse(e.data));
      } catch {
        // ignore malformed messages
      }
    };
    source.onerror = () => onEvent({ type: 'disconnected' });
    return () => source.close();
  }
}
