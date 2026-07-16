import type {
  DashboardDisplayTrustState,
  DashboardStoryBrief,
  DashboardStoryClaim,
  DashboardStoryFact,
} from '@duckcodeailabs/dql-core';
import { computeResultStats } from './synthesize.js';

export interface DashboardStoryTileResult {
  tileId: string;
  title: string;
  status: string;
  trustState?: DashboardDisplayTrustState;
  grain?: string;
  result?: { columns?: unknown[]; rows?: unknown[]; rowCount?: number };
  citation?: { kind?: string; name?: string; path?: string };
}

export interface DashboardStoryBuildInput {
  goal: string;
  audience?: string;
  filters: Record<string, unknown>;
  tiles: DashboardStoryTileResult[];
  eligibleTileIds?: string[];
  driverTileIds?: string[];
}

export interface DashboardStoryBuildResult {
  facts: DashboardStoryFact[];
  story: DashboardStoryBrief;
}

const TRUST_ORDER: Record<DashboardDisplayTrustState, number> = {
  certified: 3,
  review_required: 2,
  draft_ready: 1,
};

export function buildDeterministicDashboardStory(input: DashboardStoryBuildInput): DashboardStoryBuildResult {
  const eligible = new Set(input.eligibleTileIds ?? input.tiles.map((tile) => tile.tileId));
  const drivers = new Set(input.driverTileIds ?? []);
  const facts: DashboardStoryFact[] = [];
  for (const tile of input.tiles) {
    if (!eligible.has(tile.tileId) || tile.status !== 'ok' || !tile.result) continue;
    const columns = (tile.result.columns ?? []).map((column) => typeof column === 'string' ? column : String((column as { name?: unknown })?.name ?? column));
    const rows = (tile.result.rows ?? []).filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row));
    if (columns.length === 0 || rows.length === 0) continue;
    const stats = computeResultStats(columns, rows);
    const trustState = tile.trustState ?? 'review_required';
    const evidenceRef = tile.citation?.path ?? `${tile.citation?.kind ?? 'dashboard'}:${tile.citation?.name ?? tile.tileId}`;
    const first = rows[0] ?? {};
    const labelColumn = columns.find((column) => typeof first[column] === 'string');
    const numericStats = stats.filter((stat) => stat.kind === 'numeric');
    for (const stat of numericStats.slice(0, 2)) {
      const singleValue = rows.length === 1 && typeof first[stat.column] === 'number' ? first[stat.column] as number : undefined;
      facts.push({
        id: `${tile.tileId}:value:${stat.column}`,
        tileId: tile.tileId,
        kind: drivers.has(tile.tileId) ? 'driver' : 'value',
        label: `${tile.title} — ${humanize(stat.column)}`,
        value: singleValue ?? stat.sum ?? null,
        grain: tile.grain,
        filters: input.filters,
        evidenceRef,
        trustState,
      });
    }
    const numericColumn = numericStats[0]?.column;
    if (labelColumn && numericColumn && first[labelColumn] !== undefined && first[numericColumn] !== undefined) {
      facts.push({
        id: `${tile.tileId}:rank:1`,
        tileId: tile.tileId,
        kind: 'rank',
        label: `${tile.title} leader`,
        value: `${String(first[labelColumn])}: ${formatValue(first[numericColumn])}`,
        grain: tile.grain,
        filters: input.filters,
        evidenceRef,
        trustState,
      });
    }
  }
  const trustState = facts.reduce<DashboardDisplayTrustState>(
    (least, fact) => TRUST_ORDER[fact.trustState] < TRUST_ORDER[least] ? fact.trustState : least,
    'certified',
  );
  const scope = filterScope(input.filters);
  const primary = facts.slice(0, 3);
  const supporting = facts.slice(3, 6);
  const headline = primary.length
    ? `${humanize(input.goal).replace(/[?.!]+$/, '')}: the current picture`
    : `No result is available yet for ${humanize(input.goal).replace(/[?.!]+$/, '')}`;
  const firstParagraph = primary.length
    ? `For ${scope}, the clearest signals are ${joinFacts(primary)}. These figures come from the same settled dashboard view, so the summary and the visible results stay aligned when the filters change.`
    : `The dashboard did not return enough governed evidence to summarize ${scope}. Apply a different filter range or review the unavailable sections before using this view for a decision.`;
  const driverFacts = facts.filter((fact) => fact.kind === 'driver');
  const secondParagraph = supporting.length
    ? `${joinFacts(supporting)} add context across the rest of the view. ${driverFacts.length ? `The supported driver evidence points to ${joinFacts(driverFacts.slice(0, 2))}.` : 'The current view shows association and ranking, but it does not prove why the pattern occurred.'}`
    : `The available evidence is concentrated in ${primary.length === 1 ? 'one business signal' : 'a small set of signals'}. Use Research deeper for a validated baseline or driver breakdown before describing the pattern as a cause.`;
  const claims: DashboardStoryClaim[] = [];
  if (primary.length) claims.push({ text: firstParagraph, factIds: primary.map((fact) => fact.id), kind: 'observation' });
  if (supporting.length) claims.push({
    text: secondParagraph,
    factIds: Array.from(new Set([...supporting, ...(driverFacts.length ? driverFacts.slice(0, 2) : [])].map((fact) => fact.id))),
    kind: driverFacts.length ? 'driver' : 'observation',
  });
  return {
    facts,
    story: {
      headline,
      paragraphs: [firstParagraph, secondParagraph],
      implication: facts.length ? 'Use this view to focus the next decision on the strongest verified signal, then open the supporting evidence before acting.' : undefined,
      caveat: driverFacts.length === 0 && facts.length > 0 ? 'This view does not contain validated causal evidence.' : undefined,
      claims,
      evidenceRefs: Array.from(new Set(facts.map((fact) => fact.evidenceRef))),
      trustState: facts.length ? trustState : 'draft_ready',
      generatedBy: 'deterministic',
    },
  };
}

export function validateDashboardStoryBrief(
  story: DashboardStoryBrief,
  facts: DashboardStoryFact[],
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const allowedNumbers = new Set(facts.flatMap((fact) => [fact.value, fact.comparison?.baseline, fact.comparison?.delta])
    .filter((value) => value !== undefined && value !== null)
    .flatMap((value) => String(value).match(/-?\d+(?:\.\d+)?/g) ?? []));
  for (const value of facts.flatMap((fact) => Object.values(fact.filters ?? {}))) {
    for (const number of String(Array.isArray(value) ? value.join(' ') : value).match(/-?\d+(?:\.\d+)?/g) ?? []) allowedNumbers.add(number);
  }
  const prose = [story.headline, ...story.paragraphs, story.implication ?? '', story.caveat ?? ''].join(' ');
  for (const number of prose.match(/-?\d+(?:\.\d+)?/g) ?? []) {
    if (!allowedNumbers.has(number)) errors.push(`unsupported number: ${number}`);
  }
  for (const claim of story.claims) {
    const evidence = claim.factIds.map((id) => byId.get(id)).filter((fact): fact is DashboardStoryFact => Boolean(fact));
    if (evidence.length !== claim.factIds.length || evidence.length === 0) errors.push(`claim has missing evidence: ${claim.text}`);
    if (claim.kind === 'comparison' && !evidence.some((fact) => fact.comparison)) errors.push(`comparison has no baseline: ${claim.text}`);
    if ((claim.kind === 'driver' || /\bcaused|driven by|because of|led to\b/i.test(claim.text)) && !evidence.some((fact) => fact.kind === 'driver')) {
      errors.push(`causal claim has no driver evidence: ${claim.text}`);
    }
    const grains = new Set(evidence.map((fact) => fact.grain).filter(Boolean));
    if (grains.size > 1) errors.push(`claim mixes incompatible grains: ${claim.text}`);
    const filterFingerprints = new Set(evidence.map((fact) => JSON.stringify(fact.filters ?? {})));
    if (filterFingerprints.size > 1) errors.push(`claim mixes incompatible filters: ${claim.text}`);
  }
  return { ok: errors.length === 0, errors };
}

function joinFacts(facts: DashboardStoryFact[]): string {
  return facts.map((fact) => `${fact.label} is **${formatValue(fact.value)}**`).join(facts.length > 2 ? '; ' : ' and ');
}

function filterScope(filters: Record<string, unknown>): string {
  const active = Object.entries(filters).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (active.length === 0) return 'the current scope';
  return active.map(([key, value]) => `${humanize(key)} ${Array.isArray(value) ? value.join(' to ') : String(value)}`).join(', ');
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function formatValue(value: unknown): string {
  if (typeof value === 'number') return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value);
  return String(value ?? 'not available');
}
