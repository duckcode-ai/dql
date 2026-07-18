export type DisplayValueKind = 'currency' | 'percent' | 'integer' | 'number' | 'date' | 'boolean' | 'json' | 'text';

const CURRENCY_NAME_RE = /(?:^|_)(?:revenue|sales|spend|amount|price|cost|profit|income|expense|balance|budget|bookings|arr|mrr|gmv|fee|fees|charge|charges|tax|value)(?:_|$)/i;
const PERCENT_NAME_RE = /(?:^|_)(?:percent|percentage|pct|ratio|share|conversion|churn|retention|utilization)(?:_|$)|(?:^|_)margin(?:_|$)/i;
const INTEGER_NAME_RE = /(?:^|_)(?:count|orders?|customers?|accounts?|users?|products?|items?|units?|quantity|rank|position|days?|months?|years?|distinct)(?:_|$)/i;
const AVERAGE_NAME_RE = /(?:^|_)(?:average|avg|mean)(?:_|$)/i;
const DATE_NAME_RE = /(?:^|_)(?:date|day|month|quarter|year|time|timestamp)(?:_|$)|_(?:at|on)$/i;
const MIDNIGHT_UTC_RE = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?(?:Z|\+00:00)$/;
const ISO_TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;

function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function explicitKind(format?: string): DisplayValueKind | undefined {
  if (format === 'currency' || format === 'percent' || format === 'number') return format;
  if (format === 'duration') return 'number';
  return undefined;
}

/** Infer display semantics from the governed field name and sampled values. */
export function inferDisplayValueKind(column: string, values: unknown[] = [], format?: string): DisplayValueKind {
  const explicit = explicitKind(format);
  if (explicit) return explicit;
  if (DATE_NAME_RE.test(column)) return 'date';
  if (AVERAGE_NAME_RE.test(column) && CURRENCY_NAME_RE.test(column)) return 'currency';
  if (PERCENT_NAME_RE.test(column)) return 'percent';
  if (AVERAGE_NAME_RE.test(column)) return 'number';
  if (INTEGER_NAME_RE.test(column)) return 'integer';
  if (CURRENCY_NAME_RE.test(column)) return 'currency';

  const populated = values.filter((value) => value !== null && value !== undefined && value !== '');
  if (populated.length === 0) return 'text';
  if (populated.every((value) => typeof value === 'boolean')) return 'boolean';
  if (populated.every((value) => numericValue(value) !== undefined)) return 'number';
  if (populated.every((value) => typeof value === 'object')) return 'json';
  return 'text';
}

function numberOptions(compact: boolean, integer = false): Intl.NumberFormatOptions {
  return compact
    ? { notation: 'compact', maximumFractionDigits: 1 }
    : integer
      ? { maximumFractionDigits: 0 }
      : { maximumFractionDigits: 2 };
}

export function formatDisplayValue(
  column: string,
  value: unknown,
  values: unknown[] = [],
  options: { compact?: boolean; format?: string } = {},
): string {
  if (value === null || value === undefined) return '';
  const kind = inferDisplayValueKind(column, values, options.format);
  const numeric = numericValue(value);

  if (kind === 'date' && typeof value === 'string') {
    const midnight = MIDNIGHT_UTC_RE.exec(value);
    if (midnight) return midnight[1];
    const timestamp = ISO_TIMESTAMP_RE.exec(value);
    if (timestamp) return `${timestamp[1]} ${timestamp[2]}`;
  }
  if (numeric !== undefined) {
    if (kind === 'currency') {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        ...(options.compact
          ? { notation: 'compact', maximumFractionDigits: 1 }
          : { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      }).format(numeric);
    }
    if (kind === 'percent') {
      const normalized = Math.abs(numeric) <= 1 ? numeric : numeric / 100;
      return new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 2 }).format(normalized);
    }
    return new Intl.NumberFormat('en-US', numberOptions(Boolean(options.compact), kind === 'integer')).format(numeric);
  }
  if (kind === 'boolean') return value ? 'Yes' : 'No';
  if (kind === 'json' || typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function formatChartValue(column: string, value: number, format?: string): string {
  return formatDisplayValue(column, value, [value], { compact: true, format });
}
