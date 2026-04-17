/**
 * Chart renderer contract.
 *
 * FROZEN at v1.0. A renderer turns a QueryResult + a config object into
 * either a Vega-Lite spec (for the static compiler) or a React element
 * (for the browser runtime).
 */

import type { QueryResult } from './connector.js';

/** JSON schema describing the config shape this renderer accepts. */
export type ChartConfigSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
};

export type ChartConfig = Record<string, unknown>;

/**
 * A renderer may produce either output form; the runtime picks based on
 * target (static HTML dashboards need VegaLite; interactive notebook cells
 * can use React).
 */
export type ChartOutput =
  | { kind: 'vega-lite'; spec: Record<string, unknown> }
  | { kind: 'react'; element: unknown };

export interface ChartRenderer {
  /** Unique id — what the user writes as `visualization: <id>(…)`. */
  id: string;
  displayName: string;
  configSchema: ChartConfigSchema;

  /**
   * Validate + normalize the user-supplied config. Return a user-friendly
   * message on failure (will surface in Block Studio's lint ribbon).
   */
  validate(config: ChartConfig): { ok: true; config: ChartConfig } | { ok: false; error: string };

  /** Produce the chart output for a given result + validated config. */
  render(result: QueryResult, config: ChartConfig): ChartOutput;
}
