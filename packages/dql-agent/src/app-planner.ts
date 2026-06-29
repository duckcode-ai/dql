/**
 * App planner (P1) — turn a business goal into a planned decision surface, not a
 * keyword-ranked grid of blocks.
 *
 * Given a goal ("revenue by region"), the planner decomposes it into the questions
 * an app should answer (the headline number, its trend, breakdowns), matches each
 * to a governed metric + certified block, derives the shared filters that let one
 * control refresh every tile, writes a narrative, and reports COVERAGE + GAPS
 * (questions with no certified block — what the reflect-before-certify loop should
 * draft). Deterministic + offline; the metric match reuses the spec-17 matcher.
 */

import { matchSemanticMetric } from './metadata/metric-match.js';
import type { KGNode } from './kg/types.js';

/** A certified block as the planner needs to see it. */
export interface PlanBlock {
  name: string;
  domain?: string;
  description?: string;
  /** Governed metric this block wraps, when it is a metric_wrapper. */
  metricRef?: string;
  /** Filters a dashboard may bind (output dimension columns). */
  allowedFilters?: string[];
  dimensions?: string[];
}

export interface AppPlanSection {
  /** The business question this tile answers. */
  question: string;
  /** Kind of tile the planner intends. */
  kind: 'kpi' | 'trend' | 'breakdown';
  /** Governed metric backing it, when matched. */
  metric?: string;
  /** Certified block that covers it, when one exists. */
  blockName?: string;
  /** Dimension this section is grouped/filtered by (empty for the KPI). */
  dimension?: string;
  /** True when a certified block covers this section. */
  covered: boolean;
}

/**
 * A global dashboard control the plan prescribes (P3: dynamic dashboard semantics).
 * One control drives many tiles — `refreshes` is the explicit set of section
 * questions it re-runs, so the dashboard knows exactly what a filter change updates.
 */
export interface AppPlanFilter {
  /** The dimension the control filters on. */
  dimension: string;
  /** UI control kind, matching the runtime's filter engine. */
  control: 'daterange' | 'select' | 'number' | 'text';
  /** The section questions (tiles) this one control refreshes. */
  refreshes: string[];
}

export interface AppPlan {
  title: string;
  /** Headline narrative — what the app shows and why (the "value", not just charts). */
  narrative: string;
  sections: AppPlanSection[];
  /** Dimensions surfaced as shared filters that refresh every tile that shares them. */
  sharedFilters: string[];
  /**
   * The global filter bar the dashboard should render — each control with its kind
   * and the explicit set of tiles it refreshes (dynamic dashboard semantics).
   */
  globalFilters: AppPlanFilter[];
  /** Questions with no certified block — candidates for the build-and-certify loop. */
  gaps: string[];
  /** Fraction of sections covered by a certified block, 0..1. */
  coverage: number;
}

const TIME_DIM_RE = /(_at$|_date$|_time$|_ts$|^date$|^month$|^week$|^day$|ordered_at|created)/i;
const NUMERIC_CONTROL_RE = /(top[_-]?n|limit|count|number|amount|year|season|score)/i;

/** Classify a dimension into the dashboard control kind the filter engine renders. */
function classifyControl(dimension: string): AppPlanFilter['control'] {
  if (TIME_DIM_RE.test(dimension)) return 'daterange';
  if (NUMERIC_CONTROL_RE.test(dimension)) return 'number';
  // A categorical dimension renders as a dropdown the filter-options endpoint fills.
  return 'select';
}

function humanize(name: string): string {
  return name.replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Pull explicit "by <dimension>" requests from the goal. */
function extractRequestedDimensions(goal: string): string[] {
  const dims: string[] = [];
  const re = /\bby\s+([a-z_][a-z0-9_]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(goal.toLowerCase()))) {
    const d = m[1];
    if (d && d !== 'the' && !dims.includes(d)) dims.push(d);
  }
  return dims;
}

/** Blocks that wrap this governed metric (so we know which tiles can cover it). */
function blocksForMetric(blocks: PlanBlock[], metric: string | undefined): PlanBlock[] {
  if (!metric) return [];
  const wanted = metric.toLowerCase();
  const leaf = wanted.split('.').pop();
  return blocks.filter((b) => {
    const ref = (b.metricRef ?? '').toLowerCase();
    return ref === wanted || ref.split('.').pop() === leaf;
  });
}

/** A time dimension available on the metric's backing blocks, if any. */
function findTimeDimension(blocks: PlanBlock[]): string | undefined {
  for (const block of blocks) {
    for (const f of [...(block.allowedFilters ?? []), ...(block.dimensions ?? [])]) {
      if (TIME_DIM_RE.test(f)) return f;
    }
  }
  return undefined;
}

/** Non-time filterable dimensions across the metric's blocks. */
function categoricalDimensions(blocks: PlanBlock[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    for (const f of block.allowedFilters ?? []) {
      if (!TIME_DIM_RE.test(f) && !out.includes(f)) out.push(f);
    }
  }
  return out;
}

function coverSection(
  question: string,
  kind: AppPlanSection['kind'],
  metric: string | undefined,
  dimension: string | undefined,
  metricBlocks: PlanBlock[],
): AppPlanSection {
  // A block covers the section when it wraps the metric and (for a breakdown) the
  // dimension is one of its declared filters.
  const block = metricBlocks.find((b) =>
    !dimension || (b.allowedFilters ?? []).includes(dimension) || (b.dimensions ?? []).includes(dimension));
  return { question, kind, metric, dimension, blockName: block?.name, covered: Boolean(block) };
}

/**
 * Plan an app from a business goal. Reuses the governed-metric matcher to anchor
 * the plan on a real metric, then decomposes into KPI + trend + breakdown sections,
 * maps each to a certified block, and reports coverage + gaps.
 */
export async function planApp(input: {
  goal: string;
  metrics: KGNode[];
  blocks: PlanBlock[];
}): Promise<AppPlan> {
  // Anchor on a metric that ALREADY has certified blocks to build from (so the app
  // is assemblable), falling back to the best overall match when none is backed —
  // the unbacked match then surfaces as a gap the build-and-certify loop fills.
  const backedNames = new Set(
    input.blocks
      .map((b) => b.metricRef?.toLowerCase())
      .filter((ref): ref is string => Boolean(ref))
      .flatMap((ref) => [ref, ref.split('.').pop() ?? ref]),
  );
  const backedMetrics = input.metrics.filter(
    (m) => backedNames.has(m.name.toLowerCase()) || backedNames.has(m.name.toLowerCase().split('.').pop() ?? ''),
  );
  const match =
    (backedMetrics.length > 0 ? await matchSemanticMetric(input.goal, backedMetrics).catch(() => null) : null) ??
    (await matchSemanticMetric(input.goal, input.metrics).catch(() => null));
  const metricName = match?.metric.name;
  const label = humanize(metricName ?? input.goal).slice(0, 60) || 'metric';
  const metricBlocks = blocksForMetric(input.blocks, metricName);

  const sections: AppPlanSection[] = [];
  // 1) Headline KPI — the metric overall.
  sections.push(coverSection(`Total ${label}`, 'kpi', metricName, undefined, metricBlocks));
  // 2) Trend — the metric over a time dimension, when one is available.
  const timeDim = findTimeDimension(metricBlocks);
  if (timeDim) {
    sections.push(coverSection(`${label} over time`, 'trend', metricName, timeDim, metricBlocks));
  }
  // 3) Breakdowns — by the requested dimensions, else the top available categoricals.
  const requested = extractRequestedDimensions(input.goal).filter((d) => !TIME_DIM_RE.test(d));
  const available = categoricalDimensions(metricBlocks);
  const breakdownDims = (requested.length > 0 ? requested : available).slice(0, 3);
  for (const dim of breakdownDims) {
    sections.push(coverSection(`${label} by ${humanize(dim)}`, 'breakdown', metricName, dim, metricBlocks));
  }

  const sharedFilters = Array.from(new Set(sections.map((s) => s.dimension).filter((d): d is string => Boolean(d))));
  const covered = sections.filter((s) => s.covered).length;
  const gaps = sections.filter((s) => !s.covered).map((s) => s.question);
  const dimsText = sharedFilters.map(humanize).join(', ');

  // Global filter bar (P3): one control per shared dimension, with the EXPLICIT set
  // of covered tiles it refreshes (a covered section whose backing block declares the
  // dimension). A control that refreshes nothing flags a filter waiting on a block.
  const blockByName = new Map(metricBlocks.map((b) => [b.name, b] as const));
  const declaresFilter = (section: AppPlanSection, dim: string): boolean => {
    const block = section.blockName ? blockByName.get(section.blockName) : undefined;
    if (!block) return false;
    return (block.allowedFilters ?? []).includes(dim) || (block.dimensions ?? []).includes(dim);
  };
  const globalFilters: AppPlanFilter[] = sharedFilters.map((dimension) => ({
    dimension,
    control: classifyControl(dimension),
    refreshes: sections
      .filter((s) => s.covered && declaresFilter(s, dimension))
      .map((s) => s.question),
  }));

  return {
    title: `${label} overview`,
    narrative:
      `Tracks ${label}: the headline number` +
      (timeDim ? ', its trend over time' : '') +
      (sharedFilters.length > 0 ? `, and a breakdown by ${dimsText}.` : '.') +
      ` One filter set refreshes every tile.`,
    sections,
    sharedFilters,
    globalFilters,
    gaps,
    coverage: sections.length > 0 ? covered / sections.length : 0,
  };
}
