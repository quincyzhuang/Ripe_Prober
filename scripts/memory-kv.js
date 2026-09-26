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

  async put(entries) {
    const list = Array.isArray(entries) ? entries : [entries];
    for (const [key, value] of list) {
      this.map.set(key, value);
    }
  }
}
