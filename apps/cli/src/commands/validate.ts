import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { Parser, analyze, loadSemanticLayerFromDir, type SemanticLayer, type Diagnostic as CoreDiagnostic } from '@duckcodeailabs/dql-core';
import type { CLIFlags } from '../args.js';

interface Diagnostic {
  file: string;
  severity: 'error' | 'warning';
  message: string;
  line?: number;
}

export async function runValidate(path: string | null, flags: CLIFlags): Promise<void> {
  const projectRoot = resolve(path ?? '.');
  const diagnostics: Diagnostic[] = [];

  // Load semantic layer if present
  let semanticLayer: SemanticLayer | undefined;
  const semanticDir = join(projectRoot, 'semantic-layer');
  if (existsSync(semanticDir)) {
    try {
      semanticLayer = loadSemanticLayerFromDir(semanticDir);
    } catch (err) {
      diagnostics.push({
        file: 'semantic-layer/',
        severity: 'error',
        message: `Failed to load semantic layer: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Scan all .dql files in known directories
  const dirs = ['blocks', 'dashboards', 'workbooks'];
  let fileCount = 0;

  for (const dir of dirs) {
    const dirPath = join(projectRoot, dir);
    if (!existsSync(dirPath)) continue;

    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isFile() || extname(entry.name) !== '.dql') continue;
      const filePath = join(dirPath, entry.name);
      const relativePath = `${dir}/${entry.name}`;
      fileCount++;

      try {
        const source = readFileSync(filePath, 'utf-8');
        const parser = new Parser(source, relativePath);
        const ast = parser.parse();

        // Run semantic analysis
        try {
          const diags: CoreDiagnostic[] = analyze(ast);
          for (const diag of diags) {
            diagnostics.push({
              file: relativePath,
              severity: diag.severity === 'error' ? 'error' : 'warning',
              message: diag.message,
              line: diag.span?.start?.line,
            });
          }
        } catch {
          // analyze may throw on some inputs
        }

        // Check semantic block metric references
        for (const stmt of ast.statements) {
          if ((stmt as any).kind !== 'BlockDecl') continue;
          const block = stmt as any;
          if (block.blockType === 'semantic' && block.metricRef) {
            if (semanticLayer) {
              const composed = semanticLayer.composeQuery({
                metrics: [block.metricRef],
                dimensions: [],
              });
              if (!composed) {
                diagnostics.push({
                  file: relativePath,
                  severity: 'error',
                  message: `Metric "${block.metricRef}" referenced in block "${block.name}" not found in semantic layer`,
                });
              }
            } else {
              diagnostics.push({
                file: relativePath,
                severity: 'warning',
                message: `Semantic block "${block.name}" references metric "${block.metricRef}" but no semantic-layer/ directory exists`,
              });
            }
          }
        }
      } catch (err) {
        diagnostics.push({
          file: relativePath,
          severity: 'error',
          message: `Parse error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  // Output
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const warnings = diagnostics.filter((d) => d.severity === 'warning');

  if (flags.format === 'json') {
    console.log(JSON.stringify({ files: fileCount, diagnostics }, null, 2));
  } else {
    console.log(`\n  Validated ${fileCount} DQL file(s)\n`);
    if (diagnostics.length === 0) {
      console.log('  All files are valid.\n');
    } else {
      for (const d of diagnostics) {
        const loc = d.line ? `:${d.line}` : '';
        const icon = d.severity === 'error' ? 'ERROR' : 'WARN';
        console.log(`  ${icon} ${d.file}${loc}: ${d.message}`);
      }
      console.log(`\n  ${errors.length} error(s), ${warnings.length} warning(s)\n`);
    }
  }

  if (errors.length > 0) {
    process.exitCode = 1;
  }
}
