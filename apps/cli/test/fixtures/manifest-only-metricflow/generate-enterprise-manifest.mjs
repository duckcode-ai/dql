import { readFileSync, writeFileSync } from 'node:fs';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error('Usage: node generate-enterprise-manifest.mjs <target/manifest.json> <target/manifest.enterprise.json>');
}

const manifest = JSON.parse(readFileSync(inputPath, 'utf8'));
const opportunities = manifest.nodes?.['model.manifest_only_metricflow.fct_opportunities'];
if (!opportunities) throw new Error('Expected dbt model model.manifest_only_metricflow.fct_opportunities');

const documentedColumns = {};
for (let index = 1; index <= 50_050; index += 1) {
  documentedColumns[`filler_${String(index).padStart(5, '0')}`] = {
    name: `filler_${String(index).padStart(5, '0')}`,
    data_type: 'VARCHAR',
    description: 'Synthetic filler column for bounded manifest retrieval.',
  };
}
for (const [name, description, dataType] of [
  ['opportunity_id', 'Unique opportunity identifier.', 'INTEGER'],
  ['opportunity_outcome', 'Opportunity outcome such as lost or won.', 'VARCHAR'],
  ['lost_opportunity_count', 'One for a lost opportunity and zero otherwise.', 'INTEGER'],
  ['lost_amount', 'Amount associated with a lost opportunity.', 'DECIMAL'],
  ['close_date', 'Date the opportunity was closed.', 'DATE'],
  ['fiscal_year', 'Fiscal year label such as FY26.', 'VARCHAR'],
  ['competitor', 'Competitor involved in the opportunity.', 'VARCHAR'],
]) {
  documentedColumns[name] = { name, data_type: dataType, description };
}
opportunities.columns = documentedColumns;

manifest.nodes['model.manifest_only_metricflow.salesforce_daily_activity'] = {
  unique_id: 'model.manifest_only_metricflow.salesforce_daily_activity',
  resource_type: 'model',
  name: 'salesforce_daily_activity',
  alias: 'salesforce_daily_activity',
  database: 'MANIFEST_ONLY',
  schema: 'main',
  relation_name: '"MANIFEST_ONLY"."main"."salesforce_daily_activity"',
  original_file_path: 'models/salesforce_daily_activity.sql',
  columns: {
    activity_id: { name: 'activity_id', data_type: 'INTEGER', description: 'Sales activity identifier.' },
    activity_status: { name: 'activity_status', data_type: 'VARCHAR', description: 'Sales activity status; not opportunity outcome.' },
    activity_date: { name: 'activity_date', data_type: 'DATE', description: 'Sales activity date; not opportunity close date.' },
  },
  depends_on: { nodes: [] },
  tags: [],
};

writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Wrote ${outputPath} with ${Object.keys(documentedColumns).length} documented opportunity columns.`);
