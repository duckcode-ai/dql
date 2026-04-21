import type {
  Cell,
  CellType,
  ParamConfig,
  CellChartConfig,
  FilterCellConfig,
  PivotCellConfig,
  SingleValueCellConfig,
  TableCellConfig,
} from '../store/types';
import { makeCellId } from '../store/NotebookStore';

export interface ParsedWorkbook {
  title: string;
  cells: Cell[];
  metadata?: NotebookMetadata;
}

/**
 * Parse a .dql workbook file into a title and an array of notebook cells.
 *
 * Expected format:
 *   workbook "Title" {
 *     page "Page Name" {
 *       SELECT ...
 *     }
 *   }
 */
export function parseDqlWorkbook(content: string): ParsedWorkbook {
  try {
    // Extract workbook title
    const titleMatch = content.match(/workbook\s+"([^"]+)"/i);
    const title = titleMatch ? titleMatch[1] : 'Untitled Workbook';

    const cells: Cell[] = [];

    // Match all page blocks
    const pageRegex = /page\s+"([^"]+)"\s*\{([\s\S]*?)\}/gi;
    let match: RegExpExecArray | null;

    while ((match = pageRegex.exec(content)) !== null) {
      const pageName = match[1];
      const pageBody = match[2].trim();

      // Markdown heading cell for the page name
      cells.push({
        id: makeCellId(),
        type: 'markdown',
        content: `# ${pageName}`,
        status: 'idle',
      });

      // DQL cell with the page body
      if (pageBody) {
        cells.push({
          id: makeCellId(),
          type: 'dql',
          name: pageName.toLowerCase().replace(/\s+/g, '_'),
          content: pageBody,
          status: 'idle',
        });
      }
    }

    // If no pages found, treat entire content as a single DQL cell
    if (cells.length === 0) {
      cells.push({
        id: makeCellId(),
        type: 'dql',
        content: content.trim(),
        status: 'idle',
      });
    }

    return { title, cells };
  } catch (err) {
    console.warn('parse-workbook: falling back after error', err);
    // Fallback: single DQL cell
    return {
      title: 'Untitled Workbook',
      cells: [
        {
          id: makeCellId(),
          type: 'dql',
          content: content.trim(),
          status: 'idle',
        },
      ],
    };
  }
}

/**
 * Parse a .dqlnb JSON notebook file.
 */
export interface NotebookMetadata {
  author?: string;
  createdAt?: string;
  modifiedAt?: string;
  status?: string;           // e.g. 'draft' | 'in_review' | 'certified'
  categories?: string[];
  description?: string;
  projectFilter?: string;
}

export interface DqlNotebookFile {
  version: number;
  title: string;
  metadata?: NotebookMetadata & { title?: string };
  cells: Array<{
    id: string;
    type: CellType;
    content: string;
    source?: string;
    name?: string;
    title?: string;
    paramConfig?: ParamConfig;
    paramValue?: string;
    chartConfig?: CellChartConfig;
    filterConfig?: FilterCellConfig;
    pivotConfig?: PivotCellConfig;
    singleValueConfig?: SingleValueCellConfig;
    tableConfig?: TableCellConfig;
    upstream?: string;
  }>;
}

export function parseDqlNotebook(content: string): ParsedWorkbook {
  try {
    const data = JSON.parse(content) as DqlNotebookFile;
    const title = data.title || data.metadata?.title || 'Untitled';
    const cells: Cell[] = (data.cells || []).map((c) => ({
      id: c.id || makeCellId(),
      type: c.type || 'sql',
      content: c.content ?? c.source ?? '',
      name: c.name || c.title,
      status: 'idle' as const,
      ...(c.paramConfig ? { paramConfig: c.paramConfig } : {}),
      ...(c.paramValue !== undefined ? { paramValue: c.paramValue } : {}),
      ...(c.chartConfig ? { chartConfig: c.chartConfig } : {}),
      ...(c.filterConfig ? { filterConfig: c.filterConfig } : {}),
      ...(c.pivotConfig ? { pivotConfig: c.pivotConfig } : {}),
      ...(c.singleValueConfig ? { singleValueConfig: c.singleValueConfig } : {}),
      ...(c.tableConfig ? { tableConfig: c.tableConfig } : {}),
      ...(c.upstream ? { upstream: c.upstream } : {}),
    }));
    const { title: _metaTitle, ...restMeta } = data.metadata ?? {};
    return { title, cells, metadata: restMeta };
  } catch (err) {
    console.warn('parse-workbook: falling back after error', err);
    return {
      title: 'Untitled',
      cells: [
        {
          id: makeCellId(),
          type: 'sql',
          content: content,
          status: 'idle',
        },
      ],
    };
  }
}

/**
 * Serialize cells back to .dqlnb JSON format.
 */
export function serializeDqlNotebook(title: string, cells: Cell[], existingMetadata?: NotebookMetadata): string {
  const data: DqlNotebookFile = {
    version: 1,
    title,
    metadata: {
      ...existingMetadata,
      modifiedAt: new Date().toISOString(),
      ...(!existingMetadata?.createdAt ? { createdAt: new Date().toISOString() } : {}),
    },
    cells: cells.map((c) => ({
      id: c.id,
      type: c.type,
      content: c.content,
      ...(c.name ? { name: c.name } : {}),
      ...(c.paramConfig ? { paramConfig: c.paramConfig } : {}),
      ...(c.paramValue !== undefined ? { paramValue: c.paramValue } : {}),
      ...(c.chartConfig ? { chartConfig: c.chartConfig } : {}),
      ...(c.filterConfig ? { filterConfig: c.filterConfig } : {}),
      ...(c.pivotConfig ? { pivotConfig: c.pivotConfig } : {}),
      ...(c.singleValueConfig ? { singleValueConfig: c.singleValueConfig } : {}),
      ...(c.tableConfig ? { tableConfig: c.tableConfig } : {}),
      ...(c.upstream ? { upstream: c.upstream } : {}),
    })),
  };
  return JSON.stringify(data, null, 2);
}

/**
 * Route to the correct parser based on file extension.
 */
export function parseNotebookFile(path: string, content: string): ParsedWorkbook {
  if (path.endsWith('.dql')) {
    return parseDqlWorkbook(content);
  }
  return parseDqlNotebook(content);
}
