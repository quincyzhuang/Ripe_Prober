export class MemoryKv {
  constructor(initial = {}) {
    this.map = new Map(Object.entries(initial));
  }

  async get(keyOrKeys) {
    if (typeof keyOrKeys === 'string') {
      return this.map.get(keyOrKeys) ?? null;
    }
    return new Map(keyOrKeys.map((key) => [key, this.map.get(key) ?? null]));
  }

  /**
   * Mirrors the Workers KV binding closely enough to catch contract mistakes.
   * Bulk put is an array of { key, value } objects; an array of [key, value]
   * tuples is what the real binding rejects.
   */
  async put(...args) {
    for (const arg of args) {
      if (arg === null || typeof arg !== 'object') continue;
      for (const entry of Array.isArray(arg) ? arg : [arg]) {
        if (
          entry === null ||
          typeof entry !== 'object' ||
          Array.isArray(entry) ||
          typeof entry.key !== 'string' ||
          typeof entry.value !== 'string'
        ) {
          throw new TypeError(
            `KvNamespace.put: parameter 2 is not of type 'string or Object' (got ${
              Array.isArray(entry) ? 'an array tuple' : typeof entry
            })`,
          );
        }
        this.map.set(entry.key, entry.value);
      }
    }
  }
}
