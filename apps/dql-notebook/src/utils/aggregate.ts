export type Aggregation =
  | 'sum'
  | 'avg'
  | 'count'
  | 'count_distinct'
  | 'min'
  | 'max'
  | 'last';

export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v);
  return null;
}

/** Aggregate raw values. Returns null when a numeric aggregation has no numeric inputs. */
export function aggregate(values: unknown[], agg: Aggregation): number | null {
  if (agg === 'count') return values.length;
  if (agg === 'count_distinct') return new Set(values.map((v) => String(v))).size;
  if (agg === 'last') {
    const last = values[values.length - 1];
    return toNumber(last);
  }
  const nums = values.map(toNumber).filter((n): n is number => n !== null);
  if (nums.length === 0) return null;
  switch (agg) {
    case 'sum': return nums.reduce((a, b) => a + b, 0);
    case 'avg': return nums.reduce((a, b) => a + b, 0) / nums.length;
    case 'min': return nums.reduce((a, b) => (b < a ? b : a), nums[0]);
    case 'max': return nums.reduce((a, b) => (b > a ? b : a), nums[0]);
  }
}
