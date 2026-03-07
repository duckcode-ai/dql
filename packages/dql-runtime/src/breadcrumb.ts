import { escapeHTML } from './utils.js';

export function initBreadcrumb(): void {
  const breadcrumb = document.getElementById('dql-breadcrumb');
  if (!breadcrumb) return;

  const urlParams = new URLSearchParams(window.location.search);
  const fromPath = urlParams.get('_from');
  const fromTitle = urlParams.get('_fromTitle');
  const config = (globalThis as any).DQL_CONFIG;

  if (fromPath && fromTitle) {
    breadcrumb.innerHTML =
      `<a href="${escapeHTML(fromPath)}">${escapeHTML(fromTitle)}</a>` +
      '<span class="dql-breadcrumb-sep">/</span>' +
      `<span>${escapeHTML(config?.title ?? '')}</span>`;
  }
}
