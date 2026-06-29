import { describe, expect, it, vi } from "vitest";
import { createLlmAgentRunPlanner } from "./agent-run-planner.js";
import type { AgentRunPlanInput, AgentRunReplanInput, AgentRunStep } from "./agent-run-engine.js";

function planInput(overrides: Partial<AgentRunPlanInput> = {}): AgentRunPlanInput {
  return {
    request: { question: "why is revenue down by segment?", requestedMode: "auto" },
    routeDecision: { action: "investigate", confidence: 0.7, reason: "Open-ended analytical question.", followsUp: false },
    defaultRoute: "research",
    maxSteps: 4,
    audience: "analyst",
    ...overrides,
  };
}

function stepWithFailure(): AgentRunStep {
  return {
    id: "step-1",
    index: 1,
    route: "generated_answer",
    goal: "Answer the question",
    successCriteria: [],
    status: "needs_review",
    attempts: 1,
    evaluations: [{
      id: "grounding",
      label: "Answer grounding",
      passed: false,
      severity: "blocking",
      message: "No governed answer.",
      suggestedRepair: "Investigate instead.",
      repairAction: { kind: "escalate", route: "research" },
    }],
    artifacts: [],
  };
}

function replanInput(overrides: Partial<AgentRunReplanInput> = {}): AgentRunReplanInput {
  return {
    request: { question: "why is revenue down?", requestedMode: "auto" },
    plan: { source: "llm", rationale: "x", steps: [] },
    currentStep: stepWithFailure(),
    remainingSteps: [],
    attemptsUsed: 0,
    repairAttemptsUsed: 0,
    maxRepairAttempts: 2,
    ...overrides,
  };
}

describe("createLlmAgentRunPlanner", () => {
  it("parses a multi-step LLM plan for auto mode", async () => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify({
      rationale: "Investigate, then draft.",
      steps: [
        { route: "research", goal: "Find drivers", successCriteria: ["grounded"] },
        { route: "dql_block_draft", goal: "Draft block" },
      ],
    }));
    const planner = createLlmAgentRunPlanner({ complete });

    const plan = await planner.plan(planInput());

    expect(complete).toHaveBeenCalledTimes(1);
    expect(plan.source).toBe("llm");
    expect(plan.steps.map((step) => step.route)).toEqual(["research", "dql_block_draft"]);
    expect(plan.steps[0]?.successCriteria).toEqual(["grounded"]);
  });

  it("tolerates code fences and prose around the JSON", async () => {
    const complete = vi.fn().mockResolvedValue("Here is the plan:\n```json\n{\"rationale\":\"go\",\"steps\":[{\"route\":\"generated_answer\",\"goal\":\"answer\"}]}\n```\nDone.");
    const planner = createLlmAgentRunPlanner({ complete });

    const plan = await planner.plan(planInput());
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.route).toBe("generated_answer");
  });

  it("does not call the LLM for explicit modes (uses the deterministic single step)", async () => {
    const complete = vi.fn();
    const planner = createLlmAgentRunPlanner({ complete });

    const plan = await planner.plan(planInput({
      request: { question: "create a sql cell", requestedMode: "sql" },
      defaultRoute: "sql_cell",
    }));

    expect(complete).not.toHaveBeenCalled();
    expect(plan.source).toBe("deterministic");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.route).toBe("sql_cell");
  });

  it("falls back to deterministic when the LLM output is unparsable", async () => {
    const complete = vi.fn().mockResolvedValue("not json at all");
    const planner = createLlmAgentRunPlanner({ complete });

    const plan = await planner.plan(planInput());
    expect(plan.source).toBe("deterministic");
    expect(plan.steps[0]?.route).toBe("research");
  });

  it("falls back to deterministic when the completion throws", async () => {
    const complete = vi.fn().mockRejectedValue(new Error("provider down"));
    const planner = createLlmAgentRunPlanner({ complete });

    const plan = await planner.plan(planInput());
    expect(plan.source).toBe("deterministic");
  });

  it("drops invalid routes and caps the plan to maxSteps", async () => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify({
      rationale: "x",
      steps: [
        { route: "research", goal: "a" },
        { route: "not_a_route", goal: "b" },
        { route: "sql_cell", goal: "c" },
        { route: "dql_block_draft", goal: "d" },
      ],
    }));
    const planner = createLlmAgentRunPlanner({ complete });

    const plan = await planner.plan(planInput({ maxSteps: 2 }));
    expect(plan.steps.map((step) => step.route)).toEqual(["research", "sql_cell"]);
  });

  it("parses an escalate replan decision", async () => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify({ decision: "escalate", route: "research", goal: "investigate" }));
    const planner = createLlmAgentRunPlanner({ complete });

    const decision = await planner.replan(replanInput());
    expect(decision).toMatchObject({ decision: "escalate", route: "research" });
  });

  it("falls back to the deterministic replan on bad replan output", async () => {
    const complete = vi.fn().mockResolvedValue("garbage");
    const planner = createLlmAgentRunPlanner({ complete });

    // The failing eval carries an escalate repairAction, so deterministic escalates.
    const decision = await planner.replan(replanInput());
    expect(decision.decision).toBe("escalate");
  });

  it("collapses authoring steps to a governed answer for a stakeholder", async () => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify({
      rationale: "x",
      steps: [
        { route: "research", goal: "find drivers" },
        { route: "dql_block_draft", goal: "draft a block" },
        { route: "sql_cell", goal: "write sql" },
      ],
    }));
    const planner = createLlmAgentRunPlanner({ complete });

    const plan = await planner.plan(planInput({
      request: { question: "why is revenue down?", requestedMode: "auto", audience: "stakeholder" },
      audience: "stakeholder",
    }));
    expect(plan.steps.map((step) => step.route)).toEqual(["research", "generated_answer", "generated_answer"]);
  });

  it("passes catalog context into the plan prompt", async () => {
    const complete = vi.fn().mockResolvedValue(JSON.stringify({ rationale: "x", steps: [{ route: "research", goal: "a" }] }));
    const getCatalogContext = vi.fn().mockResolvedValue("CERTIFIED BLOCKS: revenue_total");
    const planner = createLlmAgentRunPlanner({ complete, getCatalogContext });

    await planner.plan(planInput());
    expect(getCatalogContext).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[0]?.user).toContain("revenue_total");
  });
});
