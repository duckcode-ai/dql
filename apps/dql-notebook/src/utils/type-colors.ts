/** Shared column-type color map used by SchemaPanel and DatabaseExplorer */
export const TYPE_COLORS: Record<string, string> = {
  varchar: '#388bfd',
  text: '#388bfd',
  string: '#388bfd',
  char: '#388bfd',
  integer: '#56d364',
  int: '#56d364',
  bigint: '#56d364',
  smallint: '#56d364',
  float: '#56d364',
  double: '#56d364',
  decimal: '#56d364',
  numeric: '#56d364',
  real: '#56d364',
  date: '#e3b341',
  timestamp: '#e3b341',
  datetime: '#e3b341',
  time: '#e3b341',
  boolean: '#f778ba',
  bool: '#f778ba',
  json: '#79c0ff',
  jsonb: '#79c0ff',
  uuid: '#d2a8ff',
  bytea: '#ffa657',
  binary: '#ffa657',
};

export function getTypeColor(type: string, accent: string): string {
  const lower = type.toLowerCase().split('(')[0].trim();
  return TYPE_COLORS[lower] ?? accent;
}
