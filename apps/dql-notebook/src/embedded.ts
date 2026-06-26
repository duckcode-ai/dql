// embedded.ts — minimal embed shim for the dql-notebook SPA.
//
// Activated when the URL contains ?embedded=1. Its ONLY job is localStorage
// isolation: namespace keys by the project id from `?project=<id>` so two
// tenants/projects embedding into the same cloud origin can't clobber each
// other's panel layout / last-opened-tab state.
//
// Everything else that used to live here — theme bridge, auth `x-oss-app` +
// bearer fetch wrap, `dql.embedded.ready`, route reporting, cloud-context
// injection — is now driven from OUTSIDE the OSS app by the cloud's
// build-injected adapter (governed-analytics-cloud: scripts/embed-adapter.js).
// Keeping that integration cloud-side means cloud tweaks no longer touch this
// file and OSS releases flow into the cloud unchanged. The remaining
// cloud<->OSS contract is cloud/cloud-mode.ts (routing + capabilities), which
// the AppShell consumes.

const params = new URLSearchParams(window.location.search);
const isEmbedded = params.get("embedded") === "1";
const projectId = params.get("project") || "shared";

if (isEmbedded) {
  // localStorage namespace — isolate per project within a shared cloud origin.
  const namespacedKey = (key: string): string => `dlx:${projectId}:${key}`;
  const realStorage = window.localStorage;
  const storageProxy: Storage = {
    getItem: (k: string) => realStorage.getItem(namespacedKey(k)),
    setItem: (k: string, v: string) => realStorage.setItem(namespacedKey(k), v),
    removeItem: (k: string) => realStorage.removeItem(namespacedKey(k)),
    clear: () => {
      const prefix = `dlx:${projectId}:`;
      for (let i = realStorage.length - 1; i >= 0; i--) {
        const k = realStorage.key(i);
        if (k && k.startsWith(prefix)) realStorage.removeItem(k);
      }
    },
    key: (i: number) => {
      const prefix = `dlx:${projectId}:`;
      const matched: string[] = [];
      for (let j = 0; j < realStorage.length; j++) {
        const k = realStorage.key(j);
        if (k && k.startsWith(prefix)) matched.push(k.slice(prefix.length));
      }
      return matched[i] ?? null;
    },
    get length(): number {
      const prefix = `dlx:${projectId}:`;
      let n = 0;
      for (let i = 0; i < realStorage.length; i++) {
        const k = realStorage.key(i);
        if (k && k.startsWith(prefix)) n++;
      }
      return n;
    },
  };
  Object.defineProperty(window, "localStorage", {
    value: storageProxy,
    configurable: true,
  });
}

export { isEmbedded };
