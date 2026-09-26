/**
 * ONE PLACE EVERY TOOL RUNS (RFC 0010, slice HH-7). Every tool an agent
 * loop or a provider's native tool loop calls — catalog lookups, governed
 * queries, SQL runs, the terminal `finish_answer` — runs through
 * `runGatedTool`. A host that embeds DQL installs one gate to check, log,
 * reshape or refuse each call (throw to refuse); without a gate the tool
 * simply runs. Wrappers that only decorate a tool (ledgers, metadata
 * markers) call the inner tool directly, so each call is gated once.
 */
export interface AgentToolCall {
  name: string;
  args: unknown;
}

export type AgentToolGate = (call: AgentToolCall, next: () => Promise<unknown>) => Promise<unknown>;

let installedGate: AgentToolGate | null = null;

/** Install the process's tool gate, or remove it with null. */
export function setAgentToolGate(gate: AgentToolGate | null): void {
  installedGate = gate;
}

/** Run one tool call, through the gate when one is installed. */
export async function runGatedTool<A>(tool: { name: string; run(args: A): unknown }, args: A): Promise<unknown> {
  const invoke = async () => tool.run(args);
  return installedGate ? installedGate({ name: tool.name, args }, invoke) : invoke();
}
