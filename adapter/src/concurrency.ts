// Per-chat-id mutex. A second `chat` RPC arriving while the first is streaming
// must reject instead of interleaving — concurrent turns corrupt session JSONL.

export class AsyncMutex {
  private chain: Promise<void> = Promise.resolve();

  /** Try-lock: returns true if acquired, false if already held. */
  tryRun<T>(fn: () => Promise<T>): Promise<T> | null {
    if (this.locked) return null;
    this.locked = true;
    const p = fn().finally(() => {
      this.locked = false;
    });
    return p;
  }

  private locked = false;
}

/** chat_id → mutex, created on demand. */
export class ChatMutexRegistry {
  private mutexes = new Map<string, AsyncMutex>();

  get(chatId: string): AsyncMutex {
    let m = this.mutexes.get(chatId);
    if (!m) {
      m = new AsyncMutex();
      this.mutexes.set(chatId, m);
    }
    return m;
  }

  delete(chatId: string): void {
    this.mutexes.delete(chatId);
  }
}

/** chat_id → AbortController for the in-flight turn. `stop_chat` aborts it. */
export class AbortRegistry {
  private controllers = new Map<string, AbortController>();

  register(chatId: string): AbortController {
    const ac = new AbortController();
    this.controllers.set(chatId, ac);
    return ac;
  }

  abort(chatId: string): boolean {
    const ac = this.controllers.get(chatId);
    if (!ac) return false;
    ac.abort();
    this.controllers.delete(chatId);
    return true;
  }

  clear(chatId: string): void {
    this.controllers.delete(chatId);
  }

  abortAll(): void {
    for (const ac of this.controllers.values()) ac.abort();
    this.controllers.clear();
  }
}
