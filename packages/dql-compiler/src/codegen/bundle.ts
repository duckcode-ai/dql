import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChartSpec } from './vega-lite-emitter.js';
import type { DashboardIR } from '../ir/ir-nodes.js';

export interface CompilationOutput {
  html: string;
  chartSpecs: ChartSpec[];
  runtimeJS: string;
  metadata: {
    title: string;
    schedule?: { cron: string };
    notifications: Array<{ type: string; recipients: string[] }>;
    alerts: Array<{
      conditionSQL: string;
      threshold?: number;
      operator?: '>' | '<' | '>=' | '<=' | '==' | '!=';
      message?: string;
    }>;
    queries: Array<{ id: string; sql: string }>;
    layoutDiagnostics?: Array<{
      level: 'warning' | 'error';
      message: string;
      row?: number;
      chartId?: string;
    }>;
  };
}

export function writeBundle(output: CompilationOutput, outDir: string): void {
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  // Write main HTML
  writeFileSync(join(outDir, 'index.html'), output.html, 'utf-8');

  // Write specs as JSON for debugging/inspection
  const specsDir = join(outDir, 'specs');
  if (!existsSync(specsDir)) {
    mkdirSync(specsDir, { recursive: true });
  }

  for (const spec of output.chartSpecs) {
    writeFileSync(
      join(specsDir, `${spec.chartId}.json`),
      JSON.stringify(spec.spec, null, 2),
      'utf-8',
    );
  }

  // Write metadata
  writeFileSync(
    join(outDir, 'dql-metadata.json'),
    JSON.stringify(output.metadata, null, 2),
    'utf-8',
  );
}
