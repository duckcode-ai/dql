import { describe, expect, it } from "vitest";
import {
  createNotebookDocument,
  deserializeNotebook,
  serializeNotebook,
} from "./document.js";

describe("canonical notebook document", () => {
  it("writes the shared v2 app schema while retaining the package execution model", () => {
    const source = createNotebookDocument("Research", [
      {
        id: "q1",
        type: "sql",
        title: "Query",
        source: "select 1",
        executionTarget: { target: "local" },
        future: { enabled: true },
      },
    ]);
    const serialized = serializeNotebook(source);
    const raw = JSON.parse(serialized);
    expect(raw.dqlnbVersion).toBe(2);
    expect(raw.title).toBe("Research");
    expect(raw.cells[0]).toMatchObject({
      id: "q1",
      name: "Query",
      content: "select 1",
      executionTarget: { target: "local" },
      future: { enabled: true },
    });
    expect(deserializeNotebook(serialized).cells[0]).toMatchObject({
      title: "Query",
      source: "select 1",
      executionTarget: { target: "local" },
      future: { enabled: true },
    });
  });

  it("continues reading legacy source/title notebooks", () => {
    const document = deserializeNotebook(
      JSON.stringify({
        version: 1,
        metadata: { title: "Legacy" },
        cells: [
          {
            id: "old",
            type: "chat",
            title: "Chat",
            source: "",
            chatConfig: { threadId: "t1" },
          },
        ],
      }),
    );
    expect(document.metadata.title).toBe("Legacy");
    expect(document.cells[0]).toMatchObject({
      type: "chat",
      chatConfig: { threadId: "t1" },
    });
  });
});
