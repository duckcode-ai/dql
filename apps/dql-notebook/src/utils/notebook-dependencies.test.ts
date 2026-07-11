import { describe, expect, it } from "vitest";
import type { Cell } from "../store/types";
import {
  downstreamCellIds,
  planNotebookExecution,
} from "./notebook-dependencies";

const cell = (
  id: string,
  name: string,
  content = "select 1",
  dependencies?: Cell["dependencies"],
): Cell => ({
  id,
  name,
  content,
  dependencies,
  type: "sql",
  status: "idle",
});

describe("notebook dependency graph", () => {
  it("runs cells topologically using explicit and handle dependencies", () => {
    const cells = [
      cell("c3", "final", "select * from {{middle}}"),
      cell("c2", "middle", "select * from {{raw}}"),
      cell("c1", "raw"),
    ];
    expect(planNotebookExecution(cells).ordered.map((item) => item.id)).toEqual(
      ["c1", "c2", "c3"],
    );
  });

  it("detects cycles and traces all stale downstream cells", () => {
    const cells = [
      cell("c1", "one", "select * from {{two}}"),
      cell("c2", "two", "select * from {{one}}"),
      cell("c3", "three", "select * from {{two}}"),
    ];
    expect(planNotebookExecution(cells).cycleCellIds.sort()).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
    expect([...downstreamCellIds("c1", cells)].sort()).toEqual(["c2", "c3"]);
  });
});
