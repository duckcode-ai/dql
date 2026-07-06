import type { DQLContext } from '../context.js';
import { zodInputShapeForTool } from '../tool-schema.js';

export const listMetricsInput = zodInputShapeForTool('list_metrics');

export function listMetrics(ctx: DQLContext, args: { domain?: string }) {
  const metrics = ctx.semanticLayer.listMetrics(args.domain);
  return {
    domain: args.domain ?? null,
    total: metrics.length,
    metrics: metrics.map((m) => ({
      name: m.name,
      type: m.type,
      table: m.table,
      domain: (m as unknown as { domain?: string }).domain ?? null,
      description: m.description ?? null,
      sql: m.sql ?? null,
    })),
  };
}

export const listDimensionsInput = zodInputShapeForTool('list_dimensions');

export function listDimensions(ctx: DQLContext, args: { domain?: string }) {
  const dims = ctx.semanticLayer.listDimensions(args.domain);
  return {
    domain: args.domain ?? null,
    total: dims.length,
    dimensions: dims.map((d) => ({
      name: d.name,
      table: d.table,
      type: d.type ?? null,
      description: d.description ?? null,
    })),
  };
}
