import { useEffect, useRef, useState, type DragEvent } from 'react';
import { ArrowDown, ArrowUp, CalendarDays, Hash, MoreHorizontal, Type, X } from 'lucide-react';
import type { DatasetDescriptor } from '@duckcodeailabs/dql-core/datasets/descriptor';
import type { TileQuery } from '@duckcodeailabs/dql-core/apps/tile-query';
import {
  SHELF_LABELS,
  chartFromEncoding,
  fieldKey,
  isMeasureRef,
  placeOnShelf,
  queryFromEncoding,
  refName,
  removeField,
  removeFromShelf,
  shelfAccepts,
  shelfContents,
  type DashboardVizEncoding,
  type FieldFormatKind,
  type ShelfFieldRef,
  type ShelfId,
} from '@duckcodeailabs/dql-core/apps/viz-encoding';
import { descriptorTimeField, descriptorTimeGrain, isTimeField } from './field-query';
import { humanize } from './studio-ui';

/** The drag payload a field carries between the Data pane and the shelves. */
export const FIELD_DRAG_TYPE = 'application/x-dql-field';

export function writeFieldDrag(event: DragEvent, ref: ShelfFieldRef, from?: ShelfId): void {
  event.dataTransfer.setData(FIELD_DRAG_TYPE, JSON.stringify({ ref, ...(from ? { from } : {}) }));
  event.dataTransfer.setData('text/plain', refName(ref));
  event.dataTransfer.effectAllowed = 'move';
}

function readFieldDrag(event: DragEvent): { ref: ShelfFieldRef; from?: ShelfId } | null {
  try {
    const raw = event.dataTransfer.getData(FIELD_DRAG_TYPE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ref?: ShelfFieldRef; from?: ShelfId };
    return parsed.ref && ('measure' in parsed.ref || 'dimension' in parsed.ref) ? { ref: parsed.ref, ...(parsed.from ? { from: parsed.from } : {}) } : null;
  } catch {
    return null;
  }
}

const AXES: ShelfId[] = ['columns', 'rows'];
const MARKS: ShelfId[] = ['color', 'size', 'label', 'tooltip', 'detail'];
const SHELF_HINTS: Record<ShelfId, string> = {
  columns: 'Across',
  rows: 'Down',
  color: 'Split into series',
  size: 'Bubble size',
  label: 'Show values',
  tooltip: 'Add to tooltip',
  detail: 'More detail',
};
const FORMATS: Array<[FieldFormatKind | 'auto', string]> = [['auto', 'Automatic'], ['number', 'Number'], ['compact', 'Compact (1.2K)'], ['currency', 'Currency'], ['percent', 'Percent']];

export interface ShelfChange {
  encoding: DashboardVizEncoding;
  query: TileQuery;
}

/** One sentence on what the shelves draw, for the author. */
export function describeEncodedChart(encoding: DashboardVizEncoding, isTime: (field: string) => boolean): string {
  const chart = chartFromEncoding(encoding, isTime);
  if (chart.kind === 'kpi') return 'Shows one number.';
  if (chart.kind === 'table') return chart.reason;
  if (chart.kind === 'scatter') return `A scatter of ${humanize(chart.y)} against ${humanize(chart.x)}.`;
  if (chart.kind === 'heatmap') return `A heatmap of ${humanize(chart.value)} by ${humanize(chart.x)} and ${humanize(chart.y)}.`;
  const shape = chart.line ? 'A line over' : chart.orientation === 'horizontal' ? 'Horizontal bars by' : 'Bars by';
  const series = encoding.color && !isMeasureRef(encoding.color) ? `, split by ${humanize(refName(encoding.color))}` : chart.measures.length > 1 ? `, ${chart.measures.length} series` : '';
  return `${shape} ${humanize(chart.category)}${series}.`;
}

/**
 * Shelves for a Dataset tile (RFC 0009 step 1): Columns and Rows for the
 * axes, and the marks shelves Colour, Size, Label, Tooltip and Detail. Fields
 * arrive by drag and drop from the Data pane or by click, move between
 * shelves by drag or from their menu, and every change produces a query the
 * caller validates against the Dataset contract before saving.
 */
export function ShelfEditor({
  descriptor,
  encoding,
  query,
  disabled,
  onChange,
  onFilterField,
}: {
  descriptor: DatasetDescriptor;
  encoding: DashboardVizEncoding;
  query: TileQuery;
  disabled: boolean;
  /** Returns a refusal message when the change is not allowed. */
  onChange: (change: ShelfChange) => string | void;
  onFilterField?: (field: string) => void;
}): JSX.Element {
  const [menu, setMenu] = useState<{ shelf: ShelfId; ref: ShelfFieldRef } | null>(null);
  const [over, setOver] = useState<ShelfId | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const isTime = descriptorTimeField(descriptor);
  const timeGrainFor = descriptorTimeGrain(descriptor);
  const contents = shelfContents(encoding);
  useEffect(() => setRefusal(null), [JSON.stringify(encoding)]);

  const apply = (next: DashboardVizEncoding, nextQuery?: TileQuery) => {
    const message = onChange({ encoding: next, query: nextQuery ?? queryFromEncoding(next, query, timeGrainFor) });
    setRefusal(message || null);
  };
  const dropOn = (shelf: ShelfId, event: DragEvent) => {
    event.preventDefault();
    setOver(null);
    const payload = readFieldDrag(event);
    if (!payload || disabled) return;
    if (!shelfAccepts(shelf, payload.ref)) {
      setRefusal(`${SHELF_LABELS[shelf]} takes ${shelf === 'detail' ? 'a dimension' : 'a measure'}.`);
      return;
    }
    // Moving from Label, Tooltip or Size takes it off that shelf; from the
    // Data pane or an axis, placeOnShelf moves it.
    const base = payload.from && ['size', 'label', 'tooltip'].includes(payload.from) && payload.from !== shelf
      ? removeFromShelf(encoding, payload.from, payload.ref)
      : encoding;
    apply(placeOnShelf(base, shelf, payload.ref));
  };

  const fieldLabel = (ref: ShelfFieldRef) => encoding.fields?.[fieldKey(ref)]?.label ?? humanize(refName(ref));
  const grainOf = (ref: ShelfFieldRef) => (isMeasureRef(ref) ? undefined : query.dimensions.find((dimension) => dimension.field.toLowerCase() === ref.dimension.toLowerCase())?.timeGrain);

  const renderShelf = (shelf: ShelfId, compact = false) => {
    const refs = contents[shelf];
    return (
      <div
        key={shelf}
        className={`shelf ${compact ? 'mark' : 'axis'} ${over === shelf ? 'over' : ''}`}
        onDragOver={(event) => { if (!disabled && event.dataTransfer.types.includes(FIELD_DRAG_TYPE)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setOver(shelf); } }}
        onDragLeave={() => setOver((current) => (current === shelf ? null : current))}
        onDrop={(event) => dropOn(shelf, event)}
      >
        <span className="shelf-name" title={SHELF_HINTS[shelf]}>{SHELF_LABELS[shelf]}</span>
        <ul className="shelf-pills" aria-label={`${SHELF_LABELS[shelf]} shelf`}>
          {refs.map((ref) => {
            const measure = isMeasureRef(ref);
            const grain = grainOf(ref);
            const time = !measure && isTime(refName(ref));
            return (
              <li
                key={fieldKey(ref)}
                className={`shelf-pill ${measure ? 'measure' : 'dimension'}`}
                draggable={!disabled}
                onDragStart={(event) => writeFieldDrag(event, ref, shelf)}
              >
                {measure ? <Hash size={11} aria-hidden="true" /> : time ? <CalendarDays size={11} aria-hidden="true" /> : <Type size={11} aria-hidden="true" />}
                <span className="shelf-pill-name">{fieldLabel(ref)}{grain ? <em> · {humanize(grain)}</em> : null}</span>
                <button type="button" className="shelf-pill-menu" disabled={disabled} aria-haspopup="menu" aria-expanded={menu?.shelf === shelf && fieldKey(menu.ref) === fieldKey(ref)} aria-label={`Options for ${fieldLabel(ref)} on ${SHELF_LABELS[shelf]}`} onClick={() => setMenu((current) => (current?.shelf === shelf && fieldKey(current.ref) === fieldKey(ref) ? null : { shelf, ref }))}>
                  <MoreHorizontal size={12} />
                </button>
                <button type="button" className="shelf-pill-remove" disabled={disabled} aria-label={`Remove ${fieldLabel(ref)} from ${SHELF_LABELS[shelf]}`} onClick={() => apply(removeFromShelf(encoding, shelf, ref))}>
                  <X size={11} />
                </button>
                {menu?.shelf === shelf && fieldKey(menu.ref) === fieldKey(ref) ? (
                  <FieldMenu
                    descriptor={descriptor}
                    encoding={encoding}
                    query={query}
                    shelf={shelf}
                    fieldRef={ref}
                    label={fieldLabel(ref)}
                    onClose={() => setMenu(null)}
                    onEncoding={(next, nextQuery) => { setMenu(null); apply(next, nextQuery); }}
                    onFilter={onFilterField ? () => { setMenu(null); onFilterField(refName(ref)); } : undefined}
                  />
                ) : null}
              </li>
            );
          })}
          {!refs.length ? <li className="shelf-empty" aria-hidden="true">{compact ? SHELF_HINTS[shelf] : 'Drop a field here'}</li> : null}
        </ul>
      </div>
    );
  };

  return (
    <section className="shelf-editor" aria-label="Shelves">
      {AXES.map((shelf) => renderShelf(shelf))}
      <div className="shelf-marks" role="group" aria-label="Marks">
        {MARKS.map((shelf) => renderShelf(shelf, true))}
      </div>
      <p className="shelf-reading" aria-live="polite">{describeEncodedChart(encoding, isTime)}</p>
      {refusal ? <small className="dataset-builder-error" role="alert">{refusal}</small> : null}
    </section>
  );
}

function FieldMenu({
  descriptor,
  encoding,
  query,
  shelf,
  fieldRef,
  label,
  onClose,
  onEncoding,
  onFilter,
}: {
  descriptor: DatasetDescriptor;
  encoding: DashboardVizEncoding;
  query: TileQuery;
  shelf: ShelfId;
  fieldRef: ShelfFieldRef;
  label: string;
  onClose: () => void;
  onEncoding: (next: DashboardVizEncoding, nextQuery?: TileQuery) => void;
  onFilter?: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const key = fieldKey(fieldRef);
  const settings = encoding.fields?.[key] ?? {};
  const [name, setName] = useState(settings.label ?? '');
  const measure = isMeasureRef(fieldRef);
  const field = descriptor.fields.find((candidate) => candidate.name.toLowerCase() === refName(fieldRef).toLowerCase());
  const grains = field && isTimeField(field) ? field.time?.grains ?? [] : [];
  const dimension = measure ? undefined : query.dimensions.find((entry) => entry.field.toLowerCase() === refName(fieldRef).toLowerCase());
  const alias = measure
    ? query.measures.find((entry) => entry.measure.toLowerCase() === refName(fieldRef).toLowerCase())?.alias ?? refName(fieldRef)
    : dimension?.alias ?? (dimension?.timeGrain ? `${dimension.field}_${dimension.timeGrain}` : refName(fieldRef));
  const sorted = query.orderBy?.[0]?.alias.toLowerCase() === alias.toLowerCase() ? query.orderBy[0]!.direction : null;

  useEffect(() => {
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [onClose]);

  const withSettings = (patch: { label?: string | null; format?: { kind: FieldFormatKind; decimals?: number } | null }): DashboardVizEncoding => {
    const next = { ...settings };
    if (patch.label !== undefined) { if (patch.label) next.label = patch.label; else delete next.label; }
    if (patch.format !== undefined) { if (patch.format) next.format = patch.format; else delete next.format; }
    const fields = { ...(encoding.fields ?? {}) };
    if (Object.keys(next).length) fields[key] = next;
    else delete fields[key];
    const { fields: _old, ...rest } = encoding;
    return Object.keys(fields).length ? { ...rest, fields } : rest;
  };
  const moveTargets = (['columns', 'rows', 'color', 'size', 'label', 'tooltip', 'detail'] as ShelfId[]).filter((target) => target !== shelf && shelfAccepts(target, fieldRef));
  const sortBy = (direction: 'asc' | 'desc' | null) => {
    const others = (query.orderBy ?? []).filter((entry) => entry.alias.toLowerCase() !== alias.toLowerCase());
    const orderBy = direction ? [{ alias, direction }, ...others] : others;
    const { orderBy: _previous, ...rest } = query;
    onEncoding(encoding, orderBy.length ? { ...rest, orderBy } : rest);
  };

  return (
    <div className="shelf-menu" role="menu" aria-label={`${label} options`} ref={ref}>
      <div className="shelf-menu-group" role="group" aria-label="Move to">
        <span className="shelf-menu-label">Move to</span>
        <div className="shelf-menu-chips">
          {moveTargets.map((target) => (
            <button key={target} type="button" role="menuitem" onClick={() => {
              const base = ['size', 'label', 'tooltip'].includes(shelf) ? removeFromShelf(encoding, shelf, fieldRef) : encoding;
              onEncoding(placeOnShelf(base, target, fieldRef));
            }}>{SHELF_LABELS[target]}</button>
          ))}
        </div>
      </div>
      {grains.length > 1 && dimension ? (
        <div className="shelf-menu-group" role="group" aria-label="Time grain">
          <span className="shelf-menu-label">Time grain</span>
          <div className="shelf-menu-chips">
            {grains.map((grain) => (
              <button key={grain} type="button" role="menuitemradio" aria-checked={dimension.timeGrain === grain} className={dimension.timeGrain === grain ? 'on' : ''} onClick={() => {
                const dimensions = query.dimensions.map((entry) => (entry === dimension ? { ...entry, timeGrain: grain } : entry));
                onEncoding(encoding, { ...query, dimensions, ...(query.orderBy ? { orderBy: query.orderBy.filter((entry) => entry.alias.toLowerCase() !== alias.toLowerCase()) } : {}) });
              }}>{humanize(grain)}</button>
            ))}
          </div>
        </div>
      ) : null}
      <div className="shelf-menu-group" role="group" aria-label="Sort">
        <span className="shelf-menu-label">Sort</span>
        <div className="shelf-menu-chips">
          <button type="button" role="menuitemradio" aria-checked={sorted === 'asc'} className={sorted === 'asc' ? 'on' : ''} onClick={() => sortBy('asc')}><ArrowUp size={11} aria-hidden="true" /> Ascending</button>
          <button type="button" role="menuitemradio" aria-checked={sorted === 'desc'} className={sorted === 'desc' ? 'on' : ''} onClick={() => sortBy('desc')}><ArrowDown size={11} aria-hidden="true" /> Descending</button>
          {sorted ? <button type="button" role="menuitem" onClick={() => sortBy(null)}>Clear</button> : null}
        </div>
      </div>
      {measure ? (
        <div className="shelf-menu-group" role="group" aria-label="Number format">
          <label className="shelf-menu-label" htmlFor={`format-${key}`}>Number format</label>
          <div className="shelf-menu-row">
            <select id={`format-${key}`} value={settings.format?.kind ?? 'auto'} onChange={(event) => {
              const kind = event.target.value as FieldFormatKind | 'auto';
              onEncoding(withSettings({ format: kind === 'auto' ? null : { kind, ...(settings.format?.decimals !== undefined ? { decimals: settings.format.decimals } : {}) } }));
            }}>
              {FORMATS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
            </select>
            <input aria-label="Decimals" type="number" min={0} max={6} placeholder="Dec." disabled={!settings.format} value={settings.format?.decimals ?? ''} onChange={(event) => {
              if (!settings.format) return;
              const decimals = event.target.value === '' ? undefined : Math.max(0, Math.min(6, Math.round(Number(event.target.value))));
              onEncoding(withSettings({ format: { kind: settings.format.kind, ...(decimals !== undefined ? { decimals } : {}) } }));
            }} />
          </div>
        </div>
      ) : null}
      <form className="shelf-menu-group" onSubmit={(event) => { event.preventDefault(); onEncoding(withSettings({ label: name.trim() || null })); }}>
        <label className="shelf-menu-label" htmlFor={`rename-${key}`}>Name</label>
        <div className="shelf-menu-row">
          <input id={`rename-${key}`} value={name} maxLength={80} placeholder={humanize(refName(fieldRef))} onChange={(event) => setName(event.target.value)} />
          <button type="submit">Save</button>
        </div>
      </form>
      <div className="shelf-menu-actions">
        {onFilter && !measure ? <button type="button" role="menuitem" onClick={onFilter}>Filter…</button> : null}
        <button type="button" role="menuitem" className="danger" onClick={() => onEncoding(removeField(encoding, fieldRef))}>Remove from tile</button>
      </div>
    </div>
  );
}
