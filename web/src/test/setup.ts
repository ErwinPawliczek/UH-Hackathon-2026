// Minimal in-memory localStorage so modules that touch persistence (the
// zustand persist middleware) load cleanly in the node test environment.
// Individual tests replace globalThis.localStorage with their own seeded
// instance when they need specific stored state.

class MemoryStorage implements Storage {
  #map = new Map<string, string>();

  get length(): number {
    return this.#map.size;
  }

  key(index: number): string | null {
    return [...this.#map.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.#map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#map.set(key, String(value));
  }

  removeItem(key: string): void {
    this.#map.delete(key);
  }

  clear(): void {
    this.#map.clear();
  }
}

if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = new MemoryStorage();
}
