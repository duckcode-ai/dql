import type { Cell } from '../store/types';

/**
 * Converts a notebook to a valid .dql workbook string.
 */
export function exportNotebookAsDql(title: string, cells: Cell[]): string {
  const lines: string[] = [];
  lines.push(`workbook "${title}" {`);

  let sqlIdx = 0;
  let mdIdx = 0;

  for (const cell of cells) {
    if (cell.type === 'param') {
      // Param cells are not representable in the workbook DSL — skip
      continue;
    }

    if (cell.type === 'markdown') {
      mdIdx++;
      const pageTitle = `Markdown ${mdIdx}`;
      lines.push('');
      lines.push(`  page "${pageTitle}" {`);
      // Embed markdown as line comments
      const mdLines = cell.content.split('\n');
      for (const mdLine of mdLines) {
        lines.push(`    // ${mdLine}`);
      }
      lines.push('  }');
    } else if (cell.type === 'sql') {
      sqlIdx++;
      const pageName = cell.name?.trim() || `Query ${sqlIdx}`;
      lines.push('');
      lines.push(`  page "${pageName}" {`);
      // Format SQL with 6-space indent inside chart.table(...)
      const sqlLines = cell.content.trim().split('\n');
      const indentedSql = sqlLines.map((l) => `      ${l}`).join('\n');
      lines.push(`    chart.table(`);
      lines.push(indentedSql + ',');
      lines.push(`      title = "${pageName}"`);
      lines.push('    )');
      lines.push('  }');
    } else if (cell.type === 'dql') {
      sqlIdx++;
      const pageName = cell.name?.trim() || `Query ${sqlIdx}`;
      lines.push('');
      lines.push(`  page "${pageName}" {`);
      const dqlLines = cell.content.trim().split('\n');
      for (const dqlLine of dqlLines) {
        lines.push(`    ${dqlLine}`);
      }
      lines.push('  }');
    }
  }

  lines.push('}');
  return lines.join('\n');
}

/**
 * Triggers a browser download of the .dql workbook file.
 */
export function downloadWorkbookDql(title: string, cells: Cell[]): void {
  const content = exportNotebookAsDql(title, cells);
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const filename = (title || 'notebook').replace(/[^a-zA-Z0-9_-]/g, '_') + '.dql';
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
