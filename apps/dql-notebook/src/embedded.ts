// embedded.ts — Datalex-Cloud iframe shim for the dql-notebook SPA.
//
// Activated when the URL contains ?embedded=1. Three responsibilities:
//
//   1. Theme: listen for `datalex.theme` postMessage from the parent
//      frame and apply tokens to CSS variables so the embedded SPA
//      matches Datalex-Cloud's brand palette.
//
//   2. Storage isolation: namespace localStorage keys with the project
//      id from `?project=<id>` so two tenants/projects embedding into
//      the same Datalex-Cloud origin can't clobber each other's panel
//      layout, theme prefs, or last-opened-tab state.
//
//   3. Auth pass-through: install a global fetch interceptor that adds
//      `Authorization: Bearer <token>` to every same-origin /api/* call.
//      The token is delivered to the iframe at boot via the URL hash
//      (#token=...) — Cloud's parent strips it from the visible URL
//      after install, so it never appears in browser history.
//
// On boot the shim posts `dql.embedded.ready` so the host can respond
// with theme tokens. Routes that change inside the SPA also post
// `dql.route.changed` so Cloud can keep its parent URL hash in sync
// for deep links (Slice R5).

import type { DqlCloudEmbedConfig } from "./cloud/cloud-mode";

const params = new URLSearchParams(window.location.search);
const isEmbedded = params.get("embedded") === "1";
const projectId = params.get("project") || "shared";
const isCloud = params.get("cloud") === "1";
const surface = params.get("surface") || undefined;

declare global {
  interface Window {
    __DATALEX_CLOUD_EMBED__?: DqlCloudEmbedConfig;
  }
}

// Token comes via hash so it never enters server logs / browser history.
function readAndStripToken(): string | null {
  const hash = window.location.hash;
  if (!hash) return null;
  const m = hash.match(/(?:^|[#&])token=([^&]+)/);
  if (!m) return null;
  const token = decodeURIComponent(m[1]!);
  // Strip just the token segment, keep any other hash fragments.
  const next = hash
    .replace(/(?:^|[#&])token=[^&]+/, "")
    .replace(/^[#&]/, "")
    .trim();
  history.replaceState(null, "", `${window.location.pathname}${window.location.search}${next ? `#${next}` : ""}`);
  return token;
}

if (isEmbedded) {
  // 1. localStorage namespace.
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

  // 2. Theme bridge — apply tokens posted by the parent.
  window.addEventListener("message", (ev: MessageEvent) => {
    const data = ev.data as { type?: string; tokens?: Record<string, string>; config?: DqlCloudEmbedConfig };
    if (data?.type === "dql.cloud.context" && data.config) {
      window.__DATALEX_CLOUD_EMBED__ = data.config;
      document.documentElement.dataset.datalexCloudKind = "dql";
      document.documentElement.dataset.datalexCloudSurface = String(data.config.surface ?? surface ?? "");
      return;
    }
    if (data?.type !== "datalex.theme") return;
    const tokens = data.tokens ?? {};
    const root = document.documentElement;
    if (tokens.brand) root.style.setProperty("--dql-color-accent", tokens.brand);
    if (tokens.ink900) root.style.setProperty("--dql-color-text", tokens.ink900);
    if (tokens.bg) root.style.setProperty("--dql-color-bg", tokens.bg);
    if (tokens.surface) root.style.setProperty("--dql-color-surface", tokens.surface);
    if (tokens.border) root.style.setProperty("--dql-color-border", tokens.border);
  });

  // 3. Auth pass-through. The parent posts the bearer token after
  // it receives `dql.embedded.ready`; we cache it here and use it
  // for every /api/* call. The hash-based path is a fallback for
  // pages reloaded without a parent.
  let bearerToken: string | null = readAndStripToken();
  window.addEventListener("message", (ev: MessageEvent) => {
    const data = ev.data as { type?: string; token?: string };
    if (data?.type === "datalex.auth.token" && typeof data.token === "string") {
      bearerToken = data.token;
    }
  });

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    // Only inject for same-origin project calls — leave external requests alone.
    const isApi =
      url.startsWith("/api/") ||
      url.startsWith(`${window.location.origin}/api/`);
    const isCloudApi =
      url.startsWith("/v1/") ||
      url.startsWith(`${window.location.origin}/v1/`);
    if ((!isApi && !isCloudApi) || !bearerToken) {
      return realFetch(input as RequestInfo, init);
    }
    const headers = new Headers(init?.headers ?? {});
    if (!headers.has("authorization")) {
      headers.set("authorization", `Bearer ${bearerToken}`);
    }
    return realFetch(input as RequestInfo, { ...init, headers });
  };

  // Tell the parent we're ready. The parent responds with theme + token.
  if (window.parent !== window) {
    window.parent.postMessage(
      { type: "dql.embedded.ready", projectId, cloud: isCloud, surface },
      "*",
    );
  }

  // Notify the parent on every internal route change so it can keep the
  // outer URL hash in sync for deep links.
  let lastPath = window.location.pathname + window.location.hash;
  setInterval(() => {
    const cur = window.location.pathname + window.location.hash;
    if (cur !== lastPath) {
      lastPath = cur;
      if (window.parent !== window) {
        window.parent.postMessage(
          { type: "dql.route.changed", path: cur, projectId },
          "*",
        );
      }
    }
  }, 500);
}

export { isEmbedded };
