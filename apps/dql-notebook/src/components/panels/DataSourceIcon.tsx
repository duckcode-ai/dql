import React from 'react';
import { Database, Eye, FileJson, FileSpreadsheet, Layers } from 'lucide-react';
import type { SchemaTable } from '../../store/types';

export type SchemaObjectKind = 'csv' | 'json' | 'parquet' | 'staged' | 'view' | 'table';

export function describeSchemaObject(table: SchemaTable): {
  kind: SchemaObjectKind;
  label: string;
  title: string;
  tone: 'accent' | 'success' | 'warning' | 'muted';
} {
  if (table.objectType === 'staged_dataset' || table.storageMode === 'staged') {
    return { kind: 'staged', label: 'snapshot', title: 'Bounded warehouse snapshot in the local workspace', tone: 'warning' };
  }
  const extension = table.path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const isFile = table.source === 'file' || table.objectType === 'dataset';
  if (isFile && extension === 'csv') {
    return {
      kind: 'csv',
      label: table.storageMode === 'project' ? 'project csv' : 'csv',
      title: table.storageMode === 'project' ? 'Project-controlled CSV dataset' : 'Local CSV dataset',
      tone: table.storageMode === 'project' ? 'success' : 'accent',
    };
  }
  if (isFile && (extension === 'json' || extension === 'jsonl' || extension === 'ndjson')) {
    return { kind: 'json', label: 'json', title: 'Local JSON dataset', tone: 'accent' };
  }
  if (isFile && extension === 'parquet') {
    return { kind: 'parquet', label: 'parquet', title: 'Local Parquet dataset', tone: 'accent' };
  }
  if (table.objectType?.toLowerCase().includes('view')) {
    return { kind: 'view', label: 'view', title: 'Warehouse view', tone: 'muted' };
  }
  return { kind: 'table', label: 'table', title: 'Warehouse table', tone: 'accent' };
}

export function DataSourceIcon({
  table,
  colors,
  size = 13,
}: {
  table: SchemaTable;
  colors: { accent: string; success: string; warning: string; muted: string };
  size?: number;
}) {
  const presentation = describeSchemaObject(table);
  const color = colors[presentation.tone];
  const props = { size, color, strokeWidth: 2, style: { flexShrink: 0 } } as const;
  const icon = presentation.kind === 'csv'
    ? <FileSpreadsheet {...props} />
    : presentation.kind === 'json'
      ? <FileJson {...props} />
      : presentation.kind === 'parquet' || presentation.kind === 'staged'
        ? <Layers {...props} />
        : presentation.kind === 'view'
          ? <Eye {...props} />
          : <Database {...props} />;
  return <span aria-label={presentation.title} title={presentation.title} style={{ display: 'inline-flex' }}>{icon}</span>;
}
