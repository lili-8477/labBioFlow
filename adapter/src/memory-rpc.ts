// HTTP client for the memory-api backend. Pure transport: one method per
// memory-api route, the username is supplied at construction time. No business
// logic. Handles HTTP errors as thrown Error with the API's `error` string
// when present (so dispatchInner can surface them through NATS as RPC errors).

interface ListParams {
  project_dir?: string;
  scope?: "org" | "user" | "project";
  type?: string[];
  source?: "user" | "distilled";
  include_deleted?: boolean;
  sort?: "created" | "hit";
  limit?: number;
  cursor?: string;
}

interface WriteParams {
  scope: "user" | "project" | "org";
  project_dir?: string | null;
  type: "user" | "feedback" | "project" | "reference";
  name: string;
  description: string;
  body: string;
  facets?: Record<string, string[]>;
}

export class MemoryRpcClient {
  private readonly timeoutMs = 5000;

  constructor(
    private baseUrl: string,
    private username: string,
  ) {}

  async search(params: {
    project_dir?: string | null;
    query: string;
    limit?: number;
    types?: string[];
    since?: string;
  }): Promise<unknown> {
    return this.post("/memory/search", { username: this.username, ...params });
  }

  async get(id: string): Promise<unknown> {
    return this.fetchJson(`/memory/${encodeURIComponent(id)}`);
  }

  async timeline(qs: {
    project_dir?: string;
    since?: string;
    until?: string;
    limit?: number;
  }): Promise<unknown> {
    return this.fetchJson("/memory/timeline", { username: this.username, ...qs });
  }

  async list(qs: ListParams): Promise<unknown> {
    return this.fetchJson("/memory/list", { username: this.username, ...qs });
  }

  async write(p: WriteParams): Promise<unknown> {
    return this.post("/memory/write", { username: this.username, ...p });
  }

  async update(
    id: string,
    p: { name: string; description: string; body: string },
  ): Promise<unknown> {
    return this.put(`/memory/${encodeURIComponent(id)}`, { actor: this.username, ...p });
  }

  async forget(id: string): Promise<unknown> {
    return this.post("/memory/forget", { username: this.username, memory_id: id });
  }

  async restore(id: string): Promise<unknown> {
    return this.post(`/memory/${encodeURIComponent(id)}/restore`, { actor: this.username });
  }

  async audit(id: string, limit?: number): Promise<unknown> {
    return this.fetchJson(`/memory/${encodeURIComponent(id)}/audit`, {
      actor: this.username,
      limit,
    });
  }

  private async fetchJson(
    path: string,
    qs?: Record<string, unknown>,
  ): Promise<unknown> {
    const url = this.buildUrl(path, qs);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
      });

      if (!res.ok) {
        await this.throwError(res, "GET", path);
      }

      return await res.json();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`memory-api request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const url = this.baseUrl + path;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        await this.throwError(res, "POST", path);
      }

      return await res.json();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`memory-api request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async put(
    path: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const url = this.baseUrl + path;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        await this.throwError(res, "PUT", path);
      }

      return await res.json();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`memory-api request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildUrl(path: string, qs?: Record<string, unknown>): string {
    const url = new URL(path, this.baseUrl);

    if (qs) {
      for (const [key, value] of Object.entries(qs)) {
        if (value === undefined) continue;

        if (Array.isArray(value)) {
          for (const item of value) {
            url.searchParams.append(key, String(item));
          }
        } else if (value !== null) {
          url.searchParams.append(key, String(value));
        }
      }
    }

    return url.toString();
  }

  private async throwError(res: Response, method: string, path: string): Promise<never> {
    let errorMessage: string;

    try {
      const json = (await res.json()) as Record<string, unknown>;
      errorMessage = typeof json.error === "string" ? json.error : res.statusText;
    } catch {
      errorMessage = `memory-api ${method} ${path} → HTTP ${res.status}`;
    }

    throw new Error(errorMessage);
  }
}
