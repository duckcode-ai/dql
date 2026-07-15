import { describe, expect, it } from "vitest";
import { parseDqlNotebook, serializeDqlNotebook } from "./parse-workbook";

describe(".dqlnb v2 persistence", () => {
  it("round-trips governed AI, execution, dataset, note, and legacy chat state", () => {
    const source = JSON.stringify({
      dqlnbVersion: 1,
      version: 1,
      title: "Retention research",
      cells: [
        {
          id: "cell-1",
          type: "sql",
          content: "select 1",
          executionTarget: {
            target: "connection",
            connectionName: "warehouse",
          },
          datasetRefs: [{ id: "customers_csv", role: "source" }],
          dependencies: [{ cellId: "cell-0", output: "customers" }],
          annotations: [
            {
              id: "note-1",
              body: "Validate cohort boundary",
              kind: "assumption",
              createdAt: "2026-07-10T12:00:00.000Z",
            },
          ],
          dqlArtifact: {
            source: 'block "Retention" {}',
            kind: "semantic_block",
            metrics: ["retained_customers"],
            reviewState: "draft",
          },
          dqlParameterValues: { category: "Beverage", top_n: 10 },
          chatConfig: {
            history: [],
            threadId: "thread-1",
            thread: [{ type: "assistant", text: "Ready" }],
          },
          kernel: { language: "python", environment: "reserved" },
          futureAdvancedField: { enabled: true },
        },
      ],
    });

    const parsed = parseDqlNotebook(source);
    const serialized = JSON.parse(
      serializeDqlNotebook(parsed.title, parsed.cells, parsed.metadata),
    );
    const cell = serialized.cells[0];

    expect(serialized.dqlnbVersion).toBe(2);
    expect(cell.executionTarget).toEqual({
      target: "connection",
      connectionName: "warehouse",
    });
    expect(cell.datasetRefs).toEqual([{ id: "customers_csv", role: "source" }]);
    expect(cell.dependencies).toEqual([
      { cellId: "cell-0", output: "customers" },
    ]);
    expect(cell.annotations[0].body).toBe("Validate cohort boundary");
    expect(cell.annotations[0].kind).toBe("assumption");
    expect(cell.dqlArtifact.metrics).toEqual(["retained_customers"]);
    expect(cell.dqlParameterValues).toEqual({ category: "Beverage", top_n: 10 });
    expect(cell.chatConfig.threadId).toBe("thread-1");
    expect(cell.kernel.environment).toBe("reserved");
    expect(cell.futureAdvancedField).toEqual({ enabled: true });
    expect(cell.preservedFields).toBeUndefined();
  });

  it("continues to read every legacy visual and placeholder cell type", () => {
    const types = [
      "chart",
      "table",
      "pivot",
      "single_value",
      "filter",
      "chat",
      "map",
      "writeback",
      "python",
    ];
    const parsed = parseDqlNotebook(
      JSON.stringify({
        version: 1,
        title: "Legacy",
        cells: types.map((type, index) => ({
          id: `c${index}`,
          type,
          content: "",
        })),
      }),
    );
    expect(parsed.cells.map((cell) => cell.type)).toEqual(types);
  });
});
