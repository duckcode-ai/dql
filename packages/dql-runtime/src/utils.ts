export function escapeHTML(str: unknown): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function interpolateDatum(template: string, datum: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key) => {
    const val = datum[key];
    return val === null || val === undefined ? '' : String(val);
  });
}

export function cleanDatum(datum: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(datum)) {
    if (k !== '_vgsid_' && !k.startsWith('__')) {
      clean[k] = v;
    }
  }
  return clean;
}

export function getClickedLabel(datum: Record<string, unknown>): string | null {
  const keys = Object.keys(datum).filter(
    (k) => k !== '_vgsid_' && !k.startsWith('__') && typeof datum[k] === 'string',
  );
  return keys.length > 0 ? String(datum[keys[0]]) : null;
}
