// ---------------------------------------------------------------------------
// JSON extraction from chat replies. The rest of `VeniceClient.chatJson`'s
// reply policy (the corrective retry, the empty-reply diagnosis) is in
// chat-json.ts; the HTTP stays in src/venice/client.ts.
// ---------------------------------------------------------------------------

/**
 * Pull the JSON document out of a chat reply.
 *
 * Models fence JSON in ```json blocks inconsistently, and some prepend a line
 * of narration despite being told not to. Stripping fences handles the common
 * case; falling back to the outermost brace pair handles the rest.
 */
export function extractJsonBlock(raw: string): string {
  const unfenced = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  if (unfenced.startsWith('{') || unfenced.startsWith('[')) return unfenced;

  const firstObject = unfenced.indexOf('{');
  const firstArray = unfenced.indexOf('[');
  const start = firstObject === -1
    ? firstArray
    : firstArray === -1 ? firstObject : Math.min(firstObject, firstArray);
  if (start === -1) return unfenced;

  const end = Math.max(unfenced.lastIndexOf('}'), unfenced.lastIndexOf(']'));
  return end > start ? unfenced.slice(start, end + 1) : unfenced;
}
