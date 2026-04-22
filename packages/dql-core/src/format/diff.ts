// v0.11 semantic diff for `.dql` files.
//
// `diffProgram` compares two parsed programs by top-level identity
// (block name, dashboard title, workbook title) and returns a structured
// report of added / removed / changed entities. For changed entities we
// descend into the properties that actually matter for review: SQL query,
// parameters, visualization, tests, tags, metadata.
//
// The output is intentionally lossy relative to a textual diff — it's
// meant to answer "what changed *semantically*?", not "which bytes moved".

import { parse } from '../parser/parser.js';
import { NodeKind } from '../ast/nodes.js';
import type {
  BlockDeclNode,
  BlockParamEntry,
  BlockTestNode,
  DashboardNode,
  ExpressionNode,
  NamedArgNode,
  ProgramNode,
  StatementNode,
  WorkbookNode,
} from '../ast/nodes.js';
import { formatProgram } from '../formatter/formatter.js';

export type DiffChange =
  | { kind: 'block-added'; name: string }
  | { kind: 'block-removed'; name: string }
  | { kind: 'block-changed'; name: string; fields: FieldChange[] }
  | { kind: 'dashboard-added'; title: string }
  | { kind: 'dashboard-removed'; title: string }
  | { kind: 'dashboard-changed'; title: string; fields: FieldChange[] }
  | { kind: 'workbook-added'; title: string }
  | { kind: 'workbook-removed'; title: string }
  | { kind: 'workbook-changed'; title: string; fields: FieldChange[] }
  | { kind: 'cell-added'; id: string; cellType: string; name?: string }
  | { kind: 'cell-removed'; id: string; cellType: string; name?: string }
  | { kind: 'cell-changed'; id: string; name?: string; fields: FieldChange[] }
  | { kind: 'notebook-changed'; fields: FieldChange[] };

export interface FieldChange {
  path: string;
  before: string | null;
  after: string | null;
}

export interface DiffReport {
  changes: DiffChange[];
  /** True when `before` and `after` are semantically identical at the AST level. */
  identical: boolean;
}

export function diffDQL(beforeSource: string, afterSource: string): DiffReport {
  return diffProgram(parse(beforeSource), parse(afterSource));
}

// ---- Notebook (.dqlnb) ----
// Compares by cell id so renaming a cell is one `cell-changed` with a
// `name` field change, not an add + remove. `null` before/after represent
// a new or deleted file — every entity becomes `*-added` / `*-removed`.

interface NotebookCellShape {
  id?: string;
  type?: string;
  name?: string;
  title?: string;
  content?: string;
  source?: string;
  [key: string]: unknown;
}

interface NotebookShape {
  title?: string;
  cells?: NotebookCellShape[];
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export function diffNotebook(beforeSource: string | null, afterSource: string | null): DiffReport {
  const before = parseNotebookSafe(beforeSource);
  const after = parseNotebookSafe(afterSource);
  const changes: DiffChange[] = [];

  const topFields: FieldChange[] = [];
  scalar(topFields, 'title', before?.title, after?.title);
  if (topFields.length > 0) changes.push({ kind: 'notebook-changed', fields: topFields });

  const beforeCells = indexByCellId(before?.cells);
  const afterCells = indexByCellId(after?.cells);

  for (const [id, cell] of beforeCells) {
    if (!afterCells.has(id)) {
      changes.push({
        kind: 'cell-removed',
        id,
        cellType: cell.type ?? 'unknown',
        ...(cellLabel(cell) ? { name: cellLabel(cell)! } : {}),
      });
    }
  }
  for (const [id, cell] of afterCells) {
    const prev = beforeCells.get(id);
    if (!prev) {
      changes.push({
        kind: 'cell-added',
        id,
        cellType: cell.type ?? 'unknown',
        ...(cellLabel(cell) ? { name: cellLabel(cell)! } : {}),
      });
      continue;
    }
    const fields = diffCell(prev, cell);
    if (fields.length > 0) {
      changes.push({
        kind: 'cell-changed',
        id,
        ...(cellLabel(cell) ? { name: cellLabel(cell)! } : {}),
        fields,
      });
    }
  }

  return { changes, identical: changes.length === 0 };
}

function parseNotebookSafe(source: string | null): NotebookShape | null {
  if (source === null) return null;
  try {
    return JSON.parse(source) as NotebookShape;
  } catch {
    return null;
  }
}

function indexByCellId(cells: NotebookCellShape[] | undefined): Map<string, NotebookCellShape> {
  const out = new Map<string, NotebookCellShape>();
  for (const cell of cells ?? []) {
    if (typeof cell.id === 'string' && cell.id.length > 0) out.set(cell.id, cell);
  }
  return out;
}

function cellLabel(cell: NotebookCellShape): string | undefined {
  return cell.name ?? cell.title;
}

const CELL_CONFIG_KEYS = [
  'paramConfig',
  'paramValue',
  'chartConfig',
  'filterConfig',
  'pivotConfig',
  'singleValueConfig',
  'tableConfig',
  'upstream',
  'blockBinding',
] as const;

function diffCell(a: NotebookCellShape, b: NotebookCellShape): FieldChange[] {
  const out: FieldChange[] = [];
  scalar(out, 'type', a.type, b.type);
  scalar(out, 'name', cellLabel(a), cellLabel(b));
  scalar(out, 'content', a.content ?? a.source, b.content ?? b.source);
  for (const key of CELL_CONFIG_KEYS) {
    scalar(out, key, stringifyConfig(a[key]), stringifyConfig(b[key]));
  }
  return out;
}

function stringifyConfig(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function diffProgram(before: ProgramNode, after: ProgramNode): DiffReport {
  const changes: DiffChange[] = [];

  const beforeBlocks = indexBy(before.statements.filter(isBlock), (b) => b.name);
  const afterBlocks = indexBy(after.statements.filter(isBlock), (b) => b.name);
  diffKeyed(beforeBlocks, afterBlocks, {
    onAdded: (name) => changes.push({ kind: 'block-added', name }),
    onRemoved: (name) => changes.push({ kind: 'block-removed', name }),
    onChanged: (name, a, b) => {
      const fields = diffBlock(a, b);
      if (fields.length > 0) changes.push({ kind: 'block-changed', name, fields });
    },
  });

  const beforeDashboards = indexBy(before.statements.filter(isDashboard), (d) => d.title);
  const afterDashboards = indexBy(after.statements.filter(isDashboard), (d) => d.title);
  diffKeyed(beforeDashboards, afterDashboards, {
    onAdded: (title) => changes.push({ kind: 'dashboard-added', title }),
    onRemoved: (title) => changes.push({ kind: 'dashboard-removed', title }),
    onChanged: (title, a, b) => {
      const fields = diffDashboard(a, b);
      if (fields.length > 0) changes.push({ kind: 'dashboard-changed', title, fields });
    },
  });

  const beforeWorkbooks = indexBy(before.statements.filter(isWorkbook), (w) => w.title);
  const afterWorkbooks = indexBy(after.statements.filter(isWorkbook), (w) => w.title);
  diffKeyed(beforeWorkbooks, afterWorkbooks, {
    onAdded: (title) => changes.push({ kind: 'workbook-added', title }),
    onRemoved: (title) => changes.push({ kind: 'workbook-removed', title }),
    onChanged: (title, a, b) => {
      const fields = diffWorkbook(a, b);
      if (fields.length > 0) changes.push({ kind: 'workbook-changed', title, fields });
    },
  });

  return { changes, identical: changes.length === 0 };
}

// ---- Block ----

function diffBlock(a: BlockDeclNode, b: BlockDeclNode): FieldChange[] {
  const out: FieldChange[] = [];
  scalar(out, 'domain', a.domain, b.domain);
  scalar(out, 'type', a.blockType, b.blockType);
  scalar(out, 'description', a.description, b.description);
  scalar(out, 'owner', a.owner, b.owner);
  scalar(out, 'tags', a.tags?.join(', '), b.tags?.join(', '));
  scalar(out, 'metricRef', a.metricRef, b.metricRef);
  scalar(out, 'metricsRef', a.metricsRef?.join(', '), b.metricsRef?.join(', '));
  scalar(out, 'query', normalizeSQL(a.query?.rawSQL), normalizeSQL(b.query?.rawSQL));

  diffParams(out, a.params?.params ?? [], b.params?.params ?? []);
  diffNamedArgs(out, 'visualization', a.visualization?.properties ?? [], b.visualization?.properties ?? []);
  diffTests(out, a.tests ?? [], b.tests ?? []);
  return out;
}

function diffParams(out: FieldChange[], a: BlockParamEntry[], b: BlockParamEntry[]): void {
  const am = new Map(a.map((p) => [p.name, formatExpr(p.initializer)]));
  const bm = new Map(b.map((p) => [p.name, formatExpr(p.initializer)]));
  for (const name of union(am, bm)) {
    scalar(out, `params.${name}`, am.get(name), bm.get(name));
  }
}

function diffNamedArgs(out: FieldChange[], prefix: string, a: NamedArgNode[], b: NamedArgNode[]): void {
  const am = new Map(a.map((p) => [p.name, formatExpr(p.value)]));
  const bm = new Map(b.map((p) => [p.name, formatExpr(p.value)]));
  for (const name of union(am, bm)) {
    scalar(out, `${prefix}.${name}`, am.get(name), bm.get(name));
  }
}

function diffTests(out: FieldChange[], a: BlockTestNode[], b: BlockTestNode[]): void {
  const key = (t: BlockTestNode) => `${t.field} ${t.operator}`;
  const am = new Map(a.map((t) => [key(t), formatExpr(t.expected)]));
  const bm = new Map(b.map((t) => [key(t), formatExpr(t.expected)]));
  for (const k of union(am, bm)) {
    scalar(out, `tests[${k}]`, am.get(k), bm.get(k));
  }
}

// ---- Dashboard / Workbook ----
// For dashboards/workbooks we reduce the body to its formatted text and
// diff that as a single field; an AST-level diff of charts/filters/layouts
// is possible but pays off less than block-level diffing.

function diffDashboard(a: DashboardNode, b: DashboardNode): FieldChange[] {
  const out: FieldChange[] = [];
  scalar(out, 'body', formatBody(a), formatBody(b));
  return out;
}

function diffWorkbook(a: WorkbookNode, b: WorkbookNode): FieldChange[] {
  const out: FieldChange[] = [];
  scalar(out, 'body', formatBody(a), formatBody(b));
  return out;
}

function formatBody(node: DashboardNode | WorkbookNode): string {
  const program: ProgramNode = {
    kind: NodeKind.Program,
    span: node.span,
    statements: [node],
  };
  return formatProgram(program);
}

// ---- Helpers ----

function scalar(out: FieldChange[], path: string, before: string | undefined, after: string | undefined): void {
  const b = before ?? null;
  const a = after ?? null;
  if (b !== a) out.push({ path, before: b, after: a });
}

function normalizeSQL(sql: string | undefined): string | undefined {
  if (sql == null) return undefined;
  return sql.trim().replace(/\s+/g, ' ');
}

function formatExpr(node: ExpressionNode): string {
  switch (node.kind) {
    case NodeKind.StringLiteral:
      return JSON.stringify(node.value);
    case NodeKind.NumberLiteral:
      return String(node.value);
    case NodeKind.BooleanLiteral:
      return node.value ? 'true' : 'false';
    case NodeKind.Identifier:
      return node.name;
    case NodeKind.ArrayLiteral:
      return `[${node.elements.map(formatExpr).join(', ')}]`;
    case NodeKind.BinaryExpr:
      return `${formatExpr(node.left)} ${node.operator} ${formatExpr(node.right)}`;
    case NodeKind.IntervalExpr:
      return `INTERVAL ${JSON.stringify(node.value)}`;
    case NodeKind.FunctionCall:
      return `${node.callee}(${node.arguments.map(formatExpr).join(', ')})`;
    case NodeKind.TemplateString:
      return node.parts
        .map((p) => (typeof p === 'string' ? p : `{${formatExpr(p)}}`))
        .join('');
    default:
      return '';
  }
}

function isBlock(s: StatementNode): s is BlockDeclNode {
  return s.kind === NodeKind.BlockDecl;
}

function isDashboard(s: StatementNode): s is DashboardNode {
  return s.kind === NodeKind.Dashboard;
}

function isWorkbook(s: StatementNode): s is WorkbookNode {
  return s.kind === NodeKind.Workbook;
}

function indexBy<T, K>(items: T[], key: (item: T) => K): Map<K, T> {
  const out = new Map<K, T>();
  for (const item of items) out.set(key(item), item);
  return out;
}

function diffKeyed<T>(
  before: Map<string, T>,
  after: Map<string, T>,
  handlers: {
    onAdded: (key: string) => void;
    onRemoved: (key: string) => void;
    onChanged: (key: string, before: T, after: T) => void;
  },
): void {
  for (const key of before.keys()) {
    if (!after.has(key)) handlers.onRemoved(key);
  }
  for (const [key, a] of after.entries()) {
    const b = before.get(key);
    if (b === undefined) handlers.onAdded(key);
    else handlers.onChanged(key, b, a);
  }
}

function union<K, V>(a: Map<K, V>, b: Map<K, V>): K[] {
  return Array.from(new Set([...a.keys(), ...b.keys()]));
}

// ---- Text rendering ----

export function renderDiffText(report: DiffReport): string {
  if (report.identical) return 'No changes.';
  const lines: string[] = [];
  for (const c of report.changes) {
    switch (c.kind) {
      case 'block-added':
        lines.push(`+ block "${c.name}"`);
        break;
      case 'block-removed':
        lines.push(`- block "${c.name}"`);
        break;
      case 'block-changed':
        lines.push(`~ block "${c.name}"`);
        for (const f of c.fields) {
          lines.push(`    ${f.path}: ${fmtVal(f.before)} → ${fmtVal(f.after)}`);
        }
        break;
      case 'dashboard-added':
        lines.push(`+ dashboard "${c.title}"`);
        break;
      case 'dashboard-removed':
        lines.push(`- dashboard "${c.title}"`);
        break;
      case 'dashboard-changed':
        lines.push(`~ dashboard "${c.title}" (body changed)`);
        break;
      case 'workbook-added':
        lines.push(`+ workbook "${c.title}"`);
        break;
      case 'workbook-removed':
        lines.push(`- workbook "${c.title}"`);
        break;
      case 'workbook-changed':
        lines.push(`~ workbook "${c.title}" (body changed)`);
        break;
      case 'cell-added':
        lines.push(`+ cell [${c.cellType}] ${cellRefLabel(c.id, c.name)}`);
        break;
      case 'cell-removed':
        lines.push(`- cell [${c.cellType}] ${cellRefLabel(c.id, c.name)}`);
        break;
      case 'cell-changed':
        lines.push(`~ cell ${cellRefLabel(c.id, c.name)}`);
        for (const f of c.fields) {
          lines.push(`    ${f.path}: ${fmtVal(f.before)} → ${fmtVal(f.after)}`);
        }
        break;
      case 'notebook-changed':
        lines.push(`~ notebook`);
        for (const f of c.fields) {
          lines.push(`    ${f.path}: ${fmtVal(f.before)} → ${fmtVal(f.after)}`);
        }
        break;
    }
  }
  return lines.join('\n');
}

function cellRefLabel(id: string, name?: string): string {
  return name ? `"${name}" (${id})` : id;
}

function fmtVal(v: string | null): string {
  if (v === null) return '∅';
  if (v.length > 80) return `${v.slice(0, 77)}…`;
  return v;
}
