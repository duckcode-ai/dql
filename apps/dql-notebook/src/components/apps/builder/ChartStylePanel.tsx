import { useState } from 'react';
import type { DashboardVizStyle } from '@duckcodeailabs/dql-core/apps/viz-style';

const CARTESIAN = new Set(['bar', 'grouped_bar', 'stacked_bar', 'line', 'area']);
const HAS_LEGEND = new Set(['bar', 'grouped_bar', 'stacked_bar', 'line', 'area', 'pie', 'donut']);

type Line = { value: string; label: string };
type Band = { from: string; to: string; label: string };
type Note = { at: string; text: string };

/** Drop empty fields so an untouched style stays out of the page file. */
export function compactVizStyle(style: DashboardVizStyle): DashboardVizStyle | undefined {
  const next: DashboardVizStyle = { ...style };
  for (const key of Object.keys(next) as Array<keyof DashboardVizStyle>) {
    const value = next[key];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) delete next[key];
  }
  return Object.keys(next).length ? next : undefined;
}

/** Rows typed in the panel become style entries; incomplete rows are left out. */
export function styleMarksFromRows(lines: Line[], bands: Band[], notes: Note[]): Pick<DashboardVizStyle, 'referenceLines' | 'bands' | 'annotations'> {
  const number = (value: string) => (value.trim() === '' ? NaN : Number(value));
  return {
    referenceLines: lines.flatMap((line) => {
      const value = number(line.value);
      return Number.isFinite(value) ? [{ value, ...(line.label.trim() ? { label: line.label.trim() } : {}) }] : [];
    }),
    bands: bands.flatMap((band) => {
      const from = number(band.from);
      const to = number(band.to);
      if (!Number.isFinite(from) || !Number.isFinite(to)) return [];
      return [{ from: Math.min(from, to), to: Math.max(from, to), ...(band.label.trim() ? { label: band.label.trim() } : {}) }];
    }),
    annotations: notes.flatMap((note) => (note.at.trim() && note.text.trim() ? [{ at: note.at.trim(), text: note.text.trim() }] : [])),
  };
}

/**
 * The Studio's chart style controls. Everything here writes `viz.style` on
 * the tile, the same fields the App AI writes, so a hand-styled chart and an
 * AI-styled chart are stored and rendered the same way.
 */
export function ChartStylePanel({ vizType, style, legacyFormat, disabled, onChange }: {
  vizType: string;
  style?: DashboardVizStyle;
  /** The number format a tile saved before `viz.style` existed. */
  legacyFormat?: string;
  disabled: boolean;
  onChange: (style: DashboardVizStyle | undefined) => void;
}): JSX.Element {
  const current = style ?? {};
  const cartesian = CARTESIAN.has(vizType);
  // The rows start from the saved style once per tile (the caller keys this
  // panel by tile). A save must never reset a row the author is still typing.
  const [lines, setLines] = useState<Line[]>(() => (current.referenceLines ?? []).map((line) => ({ value: String(line.value), label: line.label ?? '' })));
  const [bands, setBands] = useState<Band[]>(() => (current.bands ?? []).map((band) => ({ from: String(band.from), to: String(band.to), label: band.label ?? '' })));
  const [notes, setNotes] = useState<Note[]>(() => (current.annotations ?? []).map((note) => ({ at: note.at, text: note.text })));

  const set = (patch: Partial<DashboardVizStyle>) => onChange(compactVizStyle({ ...current, ...patch }));
  const commitMarks = (nextLines = lines, nextBands = bands, nextNotes = notes) => set(styleMarksFromRows(nextLines, nextBands, nextNotes));
  const format = current.format ?? (legacyFormat === 'currency' || legacyFormat === 'percent' ? legacyFormat : 'number');

  return <section className="chart-style-panel" aria-label="Chart style">
    <label>Style</label>
    <div className="chart-style-grid">
      <label htmlFor="chart-style-format">Numbers</label>
      <select id="chart-style-format" disabled={disabled} value={format} onChange={(event) => set({ format: event.target.value as DashboardVizStyle['format'] })}>
        <option value="number">Number</option>
        <option value="compact">Compact (1.2M)</option>
        <option value="currency">Currency</option>
        <option value="percent">Percent</option>
      </select>
      <label htmlFor="chart-style-palette">Colours</label>
      <select id="chart-style-palette" disabled={disabled} value={current.palette ?? 'dql'} onChange={(event) => set({ palette: event.target.value === 'dql' ? undefined : event.target.value as DashboardVizStyle['palette'] })}>
        <option value="dql">DQL</option>
        <option value="cool">Cool</option>
        <option value="warm">Warm</option>
        <option value="mono">Mono</option>
        <option value="pastel">Pastel</option>
      </select>
      {HAS_LEGEND.has(vizType) ? <>
        <label htmlFor="chart-style-legend">Legend</label>
        <select id="chart-style-legend" disabled={disabled} value={current.legend ?? 'top'} onChange={(event) => set({ legend: event.target.value === 'top' ? undefined : event.target.value as DashboardVizStyle['legend'] })}>
          <option value="top">Top</option>
          <option value="right">Right</option>
          <option value="bottom">Bottom</option>
          <option value="none">Hidden</option>
        </select>
      </> : null}
      {cartesian ? <>
        <label htmlFor="chart-style-labels">Value labels</label>
        <select id="chart-style-labels" disabled={disabled} value={current.labels ?? 'none'} onChange={(event) => set({ labels: event.target.value === 'none' ? undefined : event.target.value as DashboardVizStyle['labels'] })}>
          <option value="none">None</option>
          <option value="last">Last point</option>
          <option value="all">Every mark</option>
        </select>
        <label htmlFor="chart-style-sort">Order</label>
        <select id="chart-style-sort" disabled={disabled} value={current.sort ?? 'none'} onChange={(event) => set({ sort: event.target.value === 'none' ? undefined : event.target.value as DashboardVizStyle['sort'] })}>
          <option value="none">As queried</option>
          <option value="desc">Largest first</option>
          <option value="asc">Smallest first</option>
        </select>
      </> : null}
    </div>
    {cartesian ? <label className="chart-style-check" htmlFor="chart-style-stack">
      <input id="chart-style-stack" type="checkbox" disabled={disabled} checked={Boolean(current.stack)} onChange={(event) => set({ stack: event.target.checked || undefined })} />
      Stack series
    </label> : null}

    {cartesian ? <div
      className="chart-style-marks"
      // One save when focus leaves the section, so a row's value and label
      // are written together and nothing is saved mid-typing.
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) commitMarks(); }}
    >
      <span className="chart-style-heading">Reference lines</span>
      {lines.map((line, index) => <div key={`line-${index}`} className="chart-style-row">
        <input aria-label="Reference value" inputMode="decimal" placeholder="Value" disabled={disabled} value={line.value}
          onChange={(event) => setLines(lines.map((item, i) => (i === index ? { ...item, value: event.target.value } : item)))} />
        <input aria-label="Reference label" placeholder="Label" disabled={disabled} value={line.label}
          onChange={(event) => setLines(lines.map((item, i) => (i === index ? { ...item, label: event.target.value } : item)))} />
        <button type="button" aria-label="Remove reference line" disabled={disabled} onClick={() => { const next = lines.filter((_, i) => i !== index); setLines(next); commitMarks(next); }}>×</button>
      </div>)}
      <button type="button" className="chart-style-add" disabled={disabled} onClick={() => setLines([...lines, { value: '', label: '' }])}>Add reference line</button>

      <span className="chart-style-heading">Target bands</span>
      {bands.map((band, index) => <div key={`band-${index}`} className="chart-style-row">
        <input aria-label="Band from" inputMode="decimal" placeholder="From" disabled={disabled} value={band.from}
          onChange={(event) => setBands(bands.map((item, i) => (i === index ? { ...item, from: event.target.value } : item)))} />
        <input aria-label="Band to" inputMode="decimal" placeholder="To" disabled={disabled} value={band.to}
          onChange={(event) => setBands(bands.map((item, i) => (i === index ? { ...item, to: event.target.value } : item)))} />
        <input aria-label="Band label" placeholder="Label" disabled={disabled} value={band.label}
          onChange={(event) => setBands(bands.map((item, i) => (i === index ? { ...item, label: event.target.value } : item)))} />
        <button type="button" aria-label="Remove band" disabled={disabled} onClick={() => { const next = bands.filter((_, i) => i !== index); setBands(next); commitMarks(lines, next); }}>×</button>
      </div>)}
      <button type="button" className="chart-style-add" disabled={disabled} onClick={() => setBands([...bands, { from: '', to: '', label: '' }])}>Add target band</button>

      <span className="chart-style-heading">Notes on the timeline</span>
      {notes.map((note, index) => <div key={`note-${index}`} className="chart-style-row">
        <input aria-label="Note position" placeholder="2026-07-14" disabled={disabled} value={note.at}
          onChange={(event) => setNotes(notes.map((item, i) => (i === index ? { ...item, at: event.target.value } : item)))} />
        <input aria-label="Note text" placeholder="What happened" disabled={disabled} value={note.text}
          onChange={(event) => setNotes(notes.map((item, i) => (i === index ? { ...item, text: event.target.value } : item)))} />
        <button type="button" aria-label="Remove note" disabled={disabled} onClick={() => { const next = notes.filter((_, i) => i !== index); setNotes(next); commitMarks(lines, bands, next); }}>×</button>
      </div>)}
      <button type="button" className="chart-style-add" disabled={disabled} onClick={() => setNotes([...notes, { at: '', text: '' }])}>Add note</button>
      <small className="field-help">Notes are saved in the page file in git and appear on every run.</small>
    </div> : null}
  </section>;
}
