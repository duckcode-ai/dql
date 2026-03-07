import { escapeHTML } from './utils.js';

export class TableRenderer {
  render(containerId: string, data: Record<string, unknown>[], pageSize: number = 25): void {
    const container = document.getElementById(containerId);
    if (!container || !data || data.length === 0) {
      if (container) container.innerHTML = '<div class="dql-loading">No data</div>';
      return;
    }

    const colNames = Object.keys(data[0]);

    let html = '<table class="dql-drill-table" style="width:100%"><thead><tr>';
    for (const col of colNames) {
      const label = col.replace(/_/g, ' ');
      html += `<th style="cursor:pointer;" data-col="${col}">${escapeHTML(label)}</th>`;
    }
    html += '</tr></thead><tbody>';

    const maxRows = Math.min(data.length, pageSize);
    for (let r = 0; r < maxRows; r++) {
      html += '<tr>';
      for (const col of colNames) {
        let val = data[r][col];
        if (val === null || val === undefined) val = '';
        else if (typeof val === 'number') val = val.toLocaleString();
        else val = String(val);
        html += `<td>${escapeHTML(String(val))}</td>`;
      }
      html += '</tr>';
    }

    html += '</tbody></table>';
    if (data.length > pageSize) {
      html += `<p style="margin-top:12px;font-size:13px;opacity:0.7;">Showing ${maxRows} of ${data.length} rows</p>`;
    }
    container.innerHTML = html;
  }
}
