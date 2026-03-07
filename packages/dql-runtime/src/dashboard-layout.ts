export class DashboardLayout {
  private container: HTMLElement | null = null;

  mount(elementId: string): void {
    this.container = document.getElementById(elementId);
  }

  setGrid(columns: number, gap: string = '16px'): void {
    if (!this.container) return;
    this.container.style.display = 'grid';
    this.container.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
    this.container.style.gap = gap;
  }
}
