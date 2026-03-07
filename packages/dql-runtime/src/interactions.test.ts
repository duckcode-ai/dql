import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InteractionManager } from './interactions.js';
import { DataFetcher } from './data-fetcher.js';

class MockClassList {
  private values = new Set<string>();

  add(name: string): void {
    this.values.add(name);
  }

  remove(name: string): void {
    this.values.delete(name);
  }

  contains(name: string): boolean {
    return this.values.has(name);
  }
}

class MockElement {
  id: string;
  innerHTML = '';
  textContent = '';
  value = '';
  tagName = 'DIV';
  classList = new MockClassList();
  multiple = false;
  options: Array<{ value: string; selected?: boolean }> = [];
  selectedOptions: Array<{ value: string }> = [];
  private listeners: Record<string, Array<(...args: any[]) => void>> = {};

  constructor(id: string) {
    this.id = id;
  }

  addEventListener(event: string, handler: (...args: any[]) => void): void {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(handler);
  }

  emit(event: string, ...args: any[]): void {
    const handlers = this.listeners[event] || [];
    for (const handler of handlers) handler(...args);
  }
}

class MockDocument {
  private elements: Record<string, MockElement> = {};
  dispatchedTypes: string[] = [];

  constructor(ids: string[]) {
    for (const id of ids) {
      this.elements[id] = new MockElement(id);
    }
  }

  getElementById(id: string): MockElement | null {
    return this.elements[id] ?? null;
  }

  dispatchEvent(event: Event): boolean {
    this.dispatchedTypes.push((event as any).type);
    return true;
  }

  addEventListener(_event: string, _handler: (...args: any[]) => void): void {
    // no-op for test harness
  }
}

class MockView {
  private clickHandlers: Array<(event: unknown, item: any) => void> = [];
  private signalHandlers: Record<string, Array<(name: string, value: unknown) => void>> = {};

  addEventListener(event: string, handler: (event: unknown, item: any) => void): void {
    if (event === 'click') this.clickHandlers.push(handler);
  }

  addSignalListener(name: string, handler: (name: string, value: unknown) => void): void {
    if (!this.signalHandlers[name]) this.signalHandlers[name] = [];
    this.signalHandlers[name].push(handler);
  }

  emitClick(datum: Record<string, unknown>): void {
    for (const handler of this.clickHandlers) {
      handler({}, { datum });
    }
  }

  emitSignal(name: string, value: unknown): void {
    for (const handler of this.signalHandlers[name] ?? []) {
      handler(name, value);
    }
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('InteractionManager', () => {
  let originalFetch: any;
  let originalDocument: any;
  let originalWindow: any;
  let originalDQLConfig: any;
  let mockDocument: MockDocument;

  beforeEach(() => {
    originalFetch = (globalThis as any).fetch;
    originalDocument = (globalThis as any).document;
    originalWindow = (globalThis as any).window;
    originalDQLConfig = (globalThis as any).DQL_CONFIG;

    mockDocument = new MockDocument([
      'dql-drill-modal',
      'dql-drill-title',
      'dql-drill-stack',
      'dql-drill-body',
    ]);
    (globalThis as any).document = mockDocument as any;
    (globalThis as any).window = {
      location: {
        href: '',
        pathname: '/dashboard/overview',
      },
    };
    (globalThis as any).location = (globalThis as any).window.location;
    (globalThis as any).DQL_CONFIG = {
      title: 'Sales Overview',
      apiEndpoint: '/api/query',
      charts: [{ id: 'chart-1', connection: 'warehouse' }],
      interactions: {},
    };
  });

  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
    (globalThis as any).document = originalDocument;
    (globalThis as any).window = originalWindow;
    (globalThis as any).location = originalWindow?.location;
    (globalThis as any).DQL_CONFIG = originalDQLConfig;
  });

  it('captures cross-filter selections and emits state-change events', () => {
    const onStateChange = vi.fn();
    const manager = new InteractionManager(new DataFetcher('/api/query'), { onStateChange });
    const view = new MockView();

    manager.setupChartInteractions('chart-1', view as any, { filterBy: 'region' }, []);
    view.emitSignal('dql_filter', {
      vlPoint: {
        or: [{ region: 'West' }, { region: 'West' }, { region: 'East' }],
      },
    });

    expect(manager.getCrossFilters()).toEqual({
      'chart-1': { region: ['West', 'East'] },
    });
    expect(onStateChange).toHaveBeenCalled();
    expect(mockDocument.dispatchedTypes).toContain('dql:cross-filter');
  });

  it('supports drill-down and drill-up stack transitions', async () => {
    const onStateChange = vi.fn();
    const manager = new InteractionManager(new DataFetcher('/api/query'), { onStateChange });
    const view = new MockView();

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      statusText: 'OK',
      json: async () => ({
        columns: [{ name: 'order_id' }],
        rows: [{ order_id: 101 }],
      }),
    });
    (globalThis as any).fetch = fetchMock;

    manager.setupChartInteractions(
      'chart-1',
      view as any,
      { drillDown: 'SELECT * FROM orders WHERE region = {region}' },
      [],
    );

    view.emitClick({ region: 'West', _vgsid_: 10 });
    await flushPromises();

    const drillStack = manager.getDrillStack();
    expect(drillStack).toHaveLength(1);
    expect(drillStack[0].predicates).toEqual({ region: ['West'] });
    expect(mockDocument.getElementById('dql-drill-modal')?.classList.contains('active')).toBe(true);
    expect(mockDocument.getElementById('dql-drill-body')?.innerHTML).toContain('dql-drill-table');
    expect(fetchMock).toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/drill');

    await manager.drillUp();
    expect(manager.getDrillStack()).toHaveLength(0);
    expect(mockDocument.getElementById('dql-drill-modal')?.classList.contains('active')).toBe(false);
    expect(onStateChange).toHaveBeenCalled();
  });

  it('emits parameter-action events from on_click mappings', () => {
    const manager = new InteractionManager(new DataFetcher('/api/query'));
    const view = new MockView();

    manager.setupChartInteractions(
      'chart-1',
      view as any,
      { onClick: 'set_param:selected_region:region' },
      [],
    );

    view.emitClick({ region: 'Central' });
    expect(mockDocument.dispatchedTypes).toContain('dql:param-action');
  });
});

