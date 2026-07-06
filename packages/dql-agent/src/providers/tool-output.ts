/**
 * Compact a tool result for inclusion in a provider tool-loop message.
 *
 * Tool outputs can be large; we cap them so a single result can't blow the
 * context budget. When capping, we must NOT slice a serialized JSON string
 * mid-token — that yields malformed JSON the model then tries to parse. Instead
 * we return a valid JSON envelope carrying an explicit `truncated` marker and a
 * bounded preview, so the result always parses and the model is told it was cut.
 */
const DEFAULT_TOOL_OUTPUT_LIMIT = 12000;

export function compactToolOutput(output: unknown, limit = DEFAULT_TOOL_OUTPUT_LIMIT): string {
  const text = typeof output === 'string' ? output : JSON.stringify(output) ?? 'null';
  if (text.length <= limit) return text;
  return JSON.stringify({
    truncated: true,
    originalLength: text.length,
    note: `Tool result truncated to ${limit} characters. Issue a narrower query to see the rest.`,
    preview: text.slice(0, limit),
  });
}
