// Shared helpers for shaping MCP tool results.
export function textResult(data: unknown, summary?: string) {
  const json = JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text" as const, text: summary ? `${summary}\n\n${json}` : json }],
  };
}

export function noteResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}
