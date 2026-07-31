export type DisplayValueKind =
  | 'currency'
  | 'percent'
  | 'integer'
  | 'number'
  | 'year'
  | 'month'
  | 'date'
  | 'boolean'
  | 'json'
  | 'text';

const CURRENCY_NAME_RE = /(?:^|_)(?:revenue|sales|spend|amount|price|cost|profit|income|expense|balance|budget|bookings|arr|mrr|gmv|fee|fees|charge|charges|tax|value)(?:_|$)/i;
const PERCENT_NAME_RE = /(?:^|_)(?:percent|percentage|pct|ratio|share|conversion|churn|retention|utilization)(?:_|$)|(?:^|_)margin(?:_|$)/i;
const INTEGER_NAME_RE = /(?:^|_)(?:count|orders?|customers?|accounts?|users?|products?|items?|units?|quantity|rank|position|days?|months?|years?|distinct)(?:_|$)/i;
const AVERAGE_NAME_RE = /(?:^|_)(?:average|avg|mean)(?:_|$)/i;
const YEAR_NAME_RE = /(?:^|_)(?:year|yr)$/i;
const MONTH_NAME_RE = /(?:^|_)(?:month|month_num|month_number|month_of_year)$/i;
const DATE_NAME_RE = /(?:^|_)(?:date|day|month|quarter|year|time|timestamp)(?:_|$)|_(?:at|on)$/i;
const YEAR_MONTH_RE = /^(\d{4})-(\d{2})$/;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;

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
  if (MONTH_NAME_RE.test(column)) return 'month';
  if (YEAR_NAME_RE.test(column)) return 'year';
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

  if (kind === 'year') {
    const year = typeof value === 'string' && ISO_DATE_RE.test(value)
      ? Number(value.slice(0, 4))
      : numeric;
    if (year !== undefined && Number.isInteger(year)) {
      return new Intl.NumberFormat('en-US', { useGrouping: false, maximumFractionDigits: 0 }).format(year);
    }
  }
  if (kind === 'month') {
    const formattedMonth = formatMonth(value);
    if (formattedMonth) return formattedMonth;
  }
  if (kind === 'date' && typeof value === 'string') {
    const formattedDate = formatDate(value);
    if (formattedDate) return formattedDate;
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

function formatMonth(value: unknown): string | undefined {
  const numeric = numericValue(value);
  if (numeric !== undefined && Number.isInteger(numeric) && numeric >= 1 && numeric <= 12) {
    return new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' })
      .format(new Date(Date.UTC(2000, numeric - 1, 1)));
  }
  if (typeof value !== 'string') return undefined;
  const yearMonth = YEAR_MONTH_RE.exec(value);
  const isoDate = ISO_DATE_RE.exec(value);
  const match = yearMonth ?? isoDate;
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return undefined;
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, month - 1, 1)));
}

function formatDate(value: string): string | undefined {
  const dateOnly = ISO_DATE_RE.exec(value);
  if (dateOnly) {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))));
  }
  if (!ISO_TIMESTAMP_RE.test(value)) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const midnightUtc = date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0;
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(midnightUtc ? {} : { hour: 'numeric', minute: '2-digit' }),
    timeZone: 'UTC',
  }).format(date);
}
