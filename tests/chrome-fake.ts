type Stored = Record<string, unknown>;

const sessionData: Stored = {};
const localData: Stored = {};

function area(data: Stored, clone: (values: Stored) => Stored) {
  return {
    // Only the single-string-key form: every call site in src/ and tests/ uses
    // it. Clone on the way out too — real chrome.storage copies in BOTH
    // directions, so a returned object must never alias the store.
    async get(key: string): Promise<Stored> {
      return key in data ? clone({ [key]: data[key] }) : {};
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
