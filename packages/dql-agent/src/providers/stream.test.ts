import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeProvider } from "./claude.js";
import { OpenAIProvider } from "./openai.js";
import { OllamaProvider } from "./ollama.js";
import { streamOrGenerate, type AgentProvider } from "./types.js";

/** Build a Response whose body streams the given string chunks. */
function streamingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("provider token streaming", () => {
  it("Claude parses content_block_delta SSE events", async () => {
    const sse =
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    vi.spyOn(globalThis, "fetch").mockResolvedValue(streamingResponse([sse]));
    const provider = new ClaudeProvider({ apiKey: "test" });
    const deltas: string[] = [];
    const full = await provider.generateStream([{ role: "user", content: "hi" }], {}, (d) => deltas.push(d));
    expect(deltas).toEqual(["Hello ", "world"]);
    expect(full).toBe("Hello world");
  });

  it("OpenAI parses chat completion chunk deltas and skips [DONE]", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"world"}}]}\n\n' +
      'data: [DONE]\n\n';
    vi.spyOn(globalThis, "fetch").mockResolvedValue(streamingResponse([sse]));
    const provider = new OpenAIProvider({ apiKey: "test" });
    const deltas: string[] = [];
    const full = await provider.generateStream([{ role: "user", content: "hi" }], {}, (d) => deltas.push(d));
    expect(deltas).toEqual(["Hello ", "world"]);
    expect(full).toBe("Hello world");
  });

  it("Ollama parses newline-delimited JSON chunks", async () => {
    const ndjson =
      '{"message":{"content":"Hello "}}\n' +
      '{"message":{"content":"world"}}\n' +
      '{"done":true}\n';
    vi.spyOn(globalThis, "fetch").mockResolvedValue(streamingResponse([ndjson]));
    const provider = new OllamaProvider({ baseUrl: "http://127.0.0.1:11434" });
    // resolveBaseUrl calls /api/tags first; the mock returns the streaming body for any URL,
    // which is a valid 200 for the tags probe too.
    const deltas: string[] = [];
    const full = await provider.generateStream([{ role: "user", content: "hi" }], {}, (d) => deltas.push(d));
    expect(deltas).toEqual(["Hello ", "world"]);
    expect(full).toBe("Hello world");
  });

  it("streamOrGenerate degrades to a single delta for a provider without streaming", async () => {
    const provider: AgentProvider = {
      name: "claude",
      available: async () => true,
      generate: async () => "the whole answer",
    };
    const deltas: string[] = [];
    const full = await streamOrGenerate(provider, [{ role: "user", content: "hi" }], {}, (d) => deltas.push(d));
    expect(deltas).toEqual(["the whole answer"]);
    expect(full).toBe("the whole answer");
  });
});
