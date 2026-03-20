const state = {
  bootstrap: null,
  notebook: null,
  results: new Map(),
  connectionForms: [],
  draftConnection: null,
  activeConnection: null,
};

const elements = {
  projectName: document.getElementById('project-name'),
  notebookTitle: document.getElementById('notebook-title'),
  fileList: document.getElementById('file-list'),
  cells: document.getElementById('cells'),
  template: document.getElementById('cell-template'),
  driverSelect: document.getElementById('driver-select'),
  connectionFields: document.getElementById('connection-fields'),
  connectionSummary: document.getElementById('connection-summary'),
  connectionStatus: document.getElementById('connection-status'),
  runAll: document.getElementById('run-all'),
  exportNotebook: document.getElementById('export-notebook'),
  saveConnection: document.getElementById('save-connection'),
  testConnection: document.getElementById('test-connection'),
};

await bootstrap();

async function bootstrap() {
  const response = await fetch('/api/notebook/bootstrap');
  const payload = await response.json();
  state.bootstrap = payload;
  state.notebook = payload.notebook;
  state.connectionForms = payload.connectorForms;
  state.activeConnection = loadStoredConnection() || payload.defaultConnection;
  state.draftConnection = { ...state.activeConnection };

  elements.projectName.textContent = payload.project;
  elements.notebookTitle.textContent = payload.notebook.metadata.title;

  renderFiles(payload.files);
  renderConnectionForm();
  renderConnectionSummary();
  renderCells();

  document.querySelectorAll('[data-add]').forEach((button) => {
    button.addEventListener('click', () => addCell(button.getAttribute('data-add')));
  });

  elements.runAll.addEventListener('click', runAllCells);
  elements.exportNotebook.addEventListener('click', exportNotebook);
  elements.driverSelect.addEventListener('change', onDriverChange);
  elements.saveConnection.addEventListener('click', saveDraftConnection);
  elements.testConnection.addEventListener('click', testDraftConnection);
}

function renderFiles(files) {
  elements.fileList.innerHTML = '';
  files.forEach((file) => {
    const li = document.createElement('li');
    const link = document.createElement('a');
    link.href = `/api/notebook/file?path=${encodeURIComponent(file)}`;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = file;
    link.title = `Open ${file}`;
    li.appendChild(link);
    elements.fileList.appendChild(li);
  });
}

function renderConnectionSummary() {
  const connection = state.activeConnection || {};
  elements.connectionSummary.innerHTML = `
    <strong>${connection.driver || 'file'}</strong>
    <div class="field-help">${connection.host || connection.filepath || connection.database || ':memory:'}</div>
  `;
}

function renderConnectionForm() {
  elements.driverSelect.innerHTML = '';
  state.connectionForms.forEach((schema) => {
    const option = document.createElement('option');
    option.value = schema.driver;
    option.textContent = schema.label;
    if (schema.driver === state.draftConnection?.driver) {
      option.selected = true;
    }
    elements.driverSelect.appendChild(option);
  });

  const schema = currentSchema();
  if (!schema) return;

  elements.connectionFields.innerHTML = '';
  schema.fields.forEach((field) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'field';

    if (field.type === 'checkbox') {
      wrapper.innerHTML = `
        <label class="checkbox">
          <input type="checkbox" data-connection-field="${field.key}" ${state.draftConnection?.[field.key] ? 'checked' : ''} />
          <span>${field.label}</span>
        </label>
      `;
    } else {
      wrapper.innerHTML = `
        <label class="field-label">${field.label}</label>
        <input
          type="${field.type}"
          data-connection-field="${field.key}"
          value="${escapeAttribute(state.draftConnection?.[field.key] ?? '')}"
          placeholder="${escapeAttribute(field.placeholder || '')}"
        />
      `;
    }

    elements.connectionFields.appendChild(wrapper);
  });

  elements.connectionFields.querySelectorAll('[data-connection-field]').forEach((input) => {
    input.addEventListener('input', collectConnectionDraft);
    input.addEventListener('change', collectConnectionDraft);
  });
}

function currentSchema() {
  return state.connectionForms.find((schema) => schema.driver === (state.draftConnection?.driver || state.activeConnection?.driver));
}

function onDriverChange(event) {
  state.draftConnection = { driver: event.target.value };
  renderConnectionForm();
}

function collectConnectionDraft() {
  const driver = elements.driverSelect.value;
  const draft = { driver };

  elements.connectionFields.querySelectorAll('[data-connection-field]').forEach((input) => {
    const key = input.getAttribute('data-connection-field');
    if (input.type === 'checkbox') {
      draft[key] = input.checked;
    } else if (input.type === 'number') {
      draft[key] = input.value ? Number(input.value) : undefined;
    } else {
      draft[key] = input.value || undefined;
    }
  });

  state.draftConnection = draft;
}

function saveDraftConnection() {
  collectConnectionDraft();
  state.activeConnection = { ...state.draftConnection };
  localStorage.setItem(connectionStorageKey(), JSON.stringify(state.activeConnection));
  renderConnectionSummary();
  setConnectionStatus('Saved local notebook connection.', 'ok');
}

async function testDraftConnection() {
  collectConnectionDraft();
  setConnectionStatus('Testing connection…');
  try {
    const response = await fetch('/api/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connection: state.draftConnection }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || 'Connection test failed.');
    }
    setConnectionStatus('Connection test passed.', 'ok');
  } catch (error) {
    setConnectionStatus(error.message, 'error');
  }
}

function setConnectionStatus(message, kind = '') {
  elements.connectionStatus.textContent = message;
  elements.connectionStatus.className = `status ${kind}`.trim();
}

function renderCells() {
  elements.cells.innerHTML = '';
  state.notebook.cells.forEach((cell, index) => {
    const fragment = elements.template.content.cloneNode(true);
    const root = fragment.querySelector('.cell');
    const type = fragment.querySelector('.cell-type');
    const title = fragment.querySelector('.cell-title');
    const source = fragment.querySelector('.cell-source');
    const output = fragment.querySelector('.cell-output');
    const status = fragment.querySelector('.cell-status');
    const markdownPreview = fragment.querySelector('.markdown-preview');
    const chartEditor = fragment.querySelector('.chart-editor');

    root.dataset.cellId = cell.id;
    type.textContent = cell.type;
    title.value = cell.title || '';
    source.value = cell.source || '';

    title.addEventListener('input', () => {
      cell.title = title.value;
      if (index === 0) {
        state.notebook.metadata.title = title.value || state.notebook.metadata.title;
      }
    });

    if (cell.type === 'markdown') {
      markdownPreview.classList.remove('hidden');
      markdownPreview.innerHTML = renderMarkdown(cell.source);
      source.addEventListener('input', () => {
        cell.source = source.value;
        markdownPreview.innerHTML = renderMarkdown(cell.source);
      });
    } else if (cell.type === 'chart') {
      source.classList.add('hidden');
      chartEditor.classList.remove('hidden');
      renderChartEditor(chartEditor, cell);
    } else {
      source.addEventListener('input', () => {
        cell.source = source.value;
      });
    }

    const cached = state.results.get(cell.id);
    if (cached) {
      renderExecutionOutput(output, status, cell, cached);
    }

    fragment.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => handleCellAction(cell.id, button.dataset.action));
    });

    elements.cells.appendChild(fragment);
  });
}

function renderChartEditor(container, cell) {
  const config = cell.config || {};
  const sqlLikeCells = state.notebook.cells.filter((candidate) => candidate.id !== cell.id && candidate.type !== 'markdown' && candidate.type !== 'chart');
  container.innerHTML = `
    <div>
      <label class="field-label">Source cell</label>
      <select data-chart-field="sourceCellId">
        ${sqlLikeCells.map((candidate) => `<option value="${candidate.id}" ${candidate.id === config.sourceCellId ? 'selected' : ''}>${escapeHtml(candidate.title || candidate.id)}</option>`).join('')}
      </select>
    </div>
    <div>
      <label class="field-label">Chart</label>
      <select data-chart-field="chart">
        ${['bar', 'line', 'table', 'kpi'].map((chart) => `<option value="${chart}" ${chart === (config.chart || 'bar') ? 'selected' : ''}>${chart}</option>`).join('')}
      </select>
    </div>
    <div>
      <label class="field-label">X field</label>
      <input data-chart-field="x" value="${escapeAttribute(config.x || '')}" />
    </div>
    <div>
      <label class="field-label">Y field</label>
      <input data-chart-field="y" value="${escapeAttribute(config.y || '')}" />
    </div>
    <div>
      <label class="field-label">Title</label>
      <input data-chart-field="title" value="${escapeAttribute(config.title || '')}" />
    </div>
  `;

  container.querySelectorAll('[data-chart-field]').forEach((input) => {
    input.addEventListener('input', () => {
      cell.config = cell.config || {};
      cell.config[input.dataset.chartField] = input.value;
      renderLinkedChartCell(cell.id);
    });
    input.addEventListener('change', () => {
      cell.config = cell.config || {};
      cell.config[input.dataset.chartField] = input.value;
      renderLinkedChartCell(cell.id);
    });
  });
}

function handleCellAction(cellId, action) {
  const index = state.notebook.cells.findIndex((cell) => cell.id === cellId);
  if (index === -1) return;

  if (action === 'delete') {
    state.notebook.cells.splice(index, 1);
  } else if (action === 'up' && index > 0) {
    swapCells(index, index - 1);
  } else if (action === 'down' && index < state.notebook.cells.length - 1) {
    swapCells(index, index + 1);
  } else if (action === 'run') {
    runCell(state.notebook.cells[index]);
    return;
  }

  renderCells();
}

function swapCells(a, b) {
  const temp = state.notebook.cells[a];
  state.notebook.cells[a] = state.notebook.cells[b];
  state.notebook.cells[b] = temp;
}

function addCell(type) {
  const nextIndex = state.notebook.cells.length + 1;
  state.notebook.cells.push({
    id: `cell-${nextIndex}`,
    type,
    title: `${type.toUpperCase()} Cell`,
    source: type === 'markdown' ? '## New note' : type === 'sql' ? 'SELECT 1 AS value' : type === 'dql' ? 'block "New Block" {\n    domain = "general"\n    type = "custom"\n    query = """SELECT 1 AS value"""\n}' : '',
    config: type === 'chart' ? { chart: 'bar' } : undefined,
  });
  renderCells();
}

async function runAllCells() {
  for (const cell of state.notebook.cells) {
    if (cell.type === 'markdown') continue;
    await runCell(cell);
  }
}

async function runCell(cell) {
  if (cell.type === 'chart') {
    renderLinkedChartCell(cell.id);
    return;
  }

  const card = document.querySelector(`[data-cell-id="${cell.id}"]`);
  const status = card.querySelector('.cell-status');
  const output = card.querySelector('.cell-output');
  status.textContent = 'Running…';
  try {
    const response = await fetch('/api/notebook/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cell, connection: state.activeConnection }),
    });
    const payload = await response.json();
    if (!response.ok || payload.error) {
      throw new Error(payload.error || 'Notebook execution failed.');
    }

    state.results.set(cell.id, payload);
    renderExecutionOutput(output, status, cell, payload);
    rerenderDependentCharts(cell.id);
  } catch (error) {
    status.textContent = error.message;
    status.className = 'cell-status status error';
  }
}

function renderExecutionOutput(container, status, cell, payload) {
  status.textContent = payload.result ? `${payload.result.rowCount} row${payload.result.rowCount === 1 ? '' : 's'}` : 'Ready';
  status.className = 'cell-status status ok';
  container.innerHTML = '';

  if (!payload.result) {
    return;
  }

  const chartConfig = payload.chartConfig || cell.config || { chart: 'table' };
  if (cell.type === 'dql' && chartConfig.chart && chartConfig.chart !== 'table') {
    container.appendChild(renderChart(payload.result.rows, chartConfig, payload.title));
  }

  container.appendChild(renderTable(payload.result.rows));
}

function rerenderDependentCharts(sourceCellId) {
  state.notebook.cells
    .filter((cell) => cell.type === 'chart' && cell.config?.sourceCellId === sourceCellId)
    .forEach((cell) => renderLinkedChartCell(cell.id));
}

function renderLinkedChartCell(cellId) {
  const cell = state.notebook.cells.find((candidate) => candidate.id === cellId);
  if (!cell) return;
  const card = document.querySelector(`[data-cell-id="${cell.id}"]`);
  const status = card.querySelector('.cell-status');
  const output = card.querySelector('.cell-output');
  output.innerHTML = '';

  const sourceResult = state.results.get(cell.config?.sourceCellId || '');
  if (!sourceResult?.result) {
    status.textContent = 'Run the source SQL/DQL cell first.';
    status.className = 'cell-status status';
    return;
  }

  status.textContent = `Linked to ${cell.config.sourceCellId}`;
  status.className = 'cell-status status ok';
  output.appendChild(renderChart(sourceResult.result.rows, cell.config || {}, cell.title || 'Chart'));
  output.appendChild(renderTable(sourceResult.result.rows));
}

function renderChart(rows, config, title) {
  const chart = (config.chart || 'table').toLowerCase();
  const shell = document.createElement('div');
  shell.className = 'chart-card';
  shell.innerHTML = `<strong>${escapeHtml(config.title || title || 'Chart')}</strong>`;

  if (!rows.length) {
    shell.innerHTML += '<p class="field-help">No rows returned.</p>';
    return shell;
  }

  if (chart === 'kpi' || chart === 'metric') {
    const yField = config.y || Object.keys(rows[0])[0];
    const value = rows[0][yField];
    shell.innerHTML += `<div class="kpi-value">${escapeHtml(String(value ?? '—'))}</div>`;
    return shell;
  }

  if (chart === 'line') {
    const xField = config.x || Object.keys(rows[0])[0];
    const yField = config.y || Object.keys(rows[0])[1] || xField;
    shell.appendChild(renderLineChart(rows, xField, yField));
    return shell;
  }

  if (chart === 'table') {
    shell.appendChild(renderTable(rows));
    return shell;
  }

  const xField = config.x || Object.keys(rows[0])[0];
  const yField = config.y || Object.keys(rows[0])[1] || xField;
  const max = Math.max(...rows.map((row) => Number(row[yField]) || 0), 1);
  rows.slice(0, 12).forEach((row) => {
    const barRow = document.createElement('div');
    barRow.className = 'bar-row';
    const value = Number(row[yField]) || 0;
    barRow.innerHTML = `
      <span>${escapeHtml(String(row[xField] ?? ''))}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(value / max) * 100}%"></div></div>
      <strong>${escapeHtml(String(value))}</strong>
    `;
    shell.appendChild(barRow);
  });
  return shell;
}

function renderLineChart(rows, xField, yField) {
  const wrapper = document.createElement('div');
  const width = 640;
  const height = 220;
  const maxY = Math.max(...rows.map((row) => Number(row[yField]) || 0), 1);
  const step = rows.length > 1 ? width / (rows.length - 1) : width;
  const points = rows.map((row, index) => {
    const x = index * step;
    const y = height - ((Number(row[yField]) || 0) / maxY) * (height - 24) - 12;
    return `${x},${y}`;
  }).join(' ');
  wrapper.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="220" role="img" aria-label="${escapeAttribute(yField)} over ${escapeAttribute(xField)}">
      <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"></rect>
      <polyline fill="none" stroke="#59c2ff" stroke-width="3" points="${points}"></polyline>
      ${rows.map((row, index) => {
        const x = index * step;
        const y = height - ((Number(row[yField]) || 0) / maxY) * (height - 24) - 12;
        return `<circle cx="${x}" cy="${y}" r="4" fill="#8b5cf6"></circle>`;
      }).join('')}
    </svg>
  `;
  return wrapper;
}

function renderTable(rows) {
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'panel small';
    empty.textContent = 'No rows returned.';
    return empty;
  }

  const columns = Object.keys(rows[0]);
  const wrapper = document.createElement('div');
  wrapper.className = 'table-shell';
  wrapper.innerHTML = `
    <table>
      <thead>
        <tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr>
      </thead>
      <tbody>
        ${rows.slice(0, 20).map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(String(row[column] ?? ''))}</td>`).join('')}</tr>`).join('')}
      </tbody>
    </table>
  `;
  return wrapper;
}

function exportNotebook() {
  const blob = new Blob([JSON.stringify(state.notebook, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${slugify(state.notebook.metadata.title || 'notebook')}.dqlnb`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function renderMarkdown(markdown) {
  return escapeHtml(markdown)
    .replace(/^###\s+(.*)$/gm, '<h3>$1</h3>')
    .replace(/^##\s+(.*)$/gm, '<h2>$1</h2>')
    .replace(/^#\s+(.*)$/gm, '<h1>$1</h1>')
    .replace(/^[-*]\s+(.*)$/gm, '<li>$1</li>')
    .replace(/(?:\n|^)(<li>.*<\/li>)(?:\n|$)/gs, (_match, list) => `\n<ul>${list}</ul>\n`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n\n/g, '</p><p>');
}

function loadStoredConnection() {
  try {
    const raw = localStorage.getItem(connectionStorageKey());
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function connectionStorageKey() {
  const projectRoot = state.bootstrap?.projectRoot || state.bootstrap?.project || 'default';
  return `dql-notebook-connection:${projectRoot}`;
}

function slugify(value) {
  return String(value || 'notebook').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('`', '&#96;');
}
