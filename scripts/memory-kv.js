/**
 * A stand-in for the Workers KV binding, strict enough to catch the mistakes the
 * real binding rejects. It is deliberately NOT a superset of the real API:
 * notably, bulk put does not exist on the binding, so `put(key, value)` is the
 * only accepted form. Bulk get, by contrast, is supported.
 */
export class MemoryKv {
  constructor(initial = {}) {
    this.map = new Map(Object.entries(initial));
  }

  async get(keyOrKeys) {
    if (typeof keyOrKeys === 'string') {
      return this.map.get(keyOrKeys) ?? null;
    }

    if (!Array.isArray(keyOrKeys)) {
      throw new TypeError(`KvNamespace.get: expected string or string[], got ${typeof keyOrKeys}`);
    }

    return new Map(keyOrKeys.map((key) => [key, this.map.get(key) ?? null]));
  }

  async put(key, value) {
    if (Array.isArray(key) || (key !== null && typeof key === 'object')) {
      throw new TypeError(
        "KvNamespace.put: bulk writes are not supported by the binding (parameter 2 is not of type 'string or Object'). Call put(key, value) per entry.",
      );
    }
    if (typeof key !== 'string') {
      throw new TypeError(`KvNamespace.put: key must be a string, got ${typeof key}`);
    }
    if (typeof value !== 'string') {
      throw new TypeError(`KvNamespace.put: value must be a string, got ${typeof value}`);
    }

    this.map.set(key, value);
  }
}
