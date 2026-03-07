export class VegaRenderer {
  async render(containerId: string, spec: Record<string, unknown>, data: unknown[]): Promise<void> {
    const fullSpec = { ...spec, data: { values: data } };
    // vegaEmbed is loaded globally from CDN
    const vegaEmbed = (globalThis as unknown as Record<string, unknown>).vegaEmbed as
      | ((selector: string, spec: unknown, opts?: unknown) => Promise<unknown>)
      | undefined;

    if (!vegaEmbed) {
      throw new Error('vega-embed not loaded. Include the Vega-Lite CDN scripts.');
    }

    await vegaEmbed(`#${containerId}`, fullSpec, {
      actions: false,
      renderer: 'svg',
    });
  }
}
