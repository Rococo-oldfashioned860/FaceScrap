type Stored = Record<string, unknown>;

const sessionData: Stored = {};
const localData: Stored = {};

function area(data: Stored, clone: (values: Stored) => Stored) {
  return {
    // Clone on the way out too — real chrome.storage copies in BOTH directions,
    // so a returned object must never alias the store. `null` is the Chrome API
    // form for an area-wide snapshot; quota recovery needs one atomic view of
    // every per-tab media key before choosing safe global eviction candidates.
    async get(key: string | string[] | null): Promise<Stored> {
      if (key === null) return clone(data);
      const keys = typeof key === 'string' ? [key] : key;
      const selected: Stored = {};
      for (const candidate of keys) {
        if (candidate in data) selected[candidate] = data[candidate];
      }
      return clone(selected);
    },
    async set(values: Stored): Promise<void> {
      Object.assign(data, clone(values));
    },
    async remove(keys: string | string[]): Promise<void> {
      for (const key of typeof keys === 'string' ? [keys] : keys) delete data[key];
    },
    async clear(): Promise<void> {
      for (const key of Object.keys(data)) delete data[key];
    },
  };
}

Object.defineProperty(globalThis, 'chrome', {
  configurable: true,
  value: {
    storage: {
      // session is in-memory in real Chrome and keeps structured-clone
      // semantics; local persists through JSON-ish serialization that drops
      // undefined-valued keys and functions and mangles Dates — mirror both so
      // a test can't assert fidelity the real API does not provide.
      session: area(sessionData, (values) => structuredClone(values)),
      local: area(localData, (values) => JSON.parse(JSON.stringify(values)) as Stored),
      onChanged: { addListener() {} },
    },
  },
});

export async function resetChromeStorage(): Promise<void> {
  await chrome.storage.session.clear();
  await chrome.storage.local.clear();
}
