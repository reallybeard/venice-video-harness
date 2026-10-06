// ---------------------------------------------------------------------------
// The chatJson reply policy (rule 47) -- pure. Build the /chat/completions body
// for each attempt and decide what a reply means: the parsed value, one more
// attempt (and with which messages), or the error to throw. The HTTP stays
// with the host (the CLI: `VeniceClient.chatJson` in src/venice/client.ts).
// ---------------------------------------------------------------------------

import { extractJsonBlock } from './json-block.js';

/** A chat completion that must come back as JSON (`VeniceClient.chatJson`). */
export interface ChatJsonRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /** Data URIs. Supplying any makes this a vision request. */
  images?: string[];
  maxTokens?: number;
  temperature?: number;
  /** What is being generated, for error messages, e.g. 'workshop'. */
  label?: string;
  /**
   * Ask the model to answer directly, with no chain of thought
   * (`venice_parameters.disable_thinking`). For short, latency-bound
   * generations (the stream writer) this is the difference between ~4s and
   * ~35s on the same model. Thinking-only models (GLM 5.3) reject the flag
   * with a 400; callers that pass it should pick a model that honors it.
   */
  disableThinking?: boolean;
}

/** One `/chat/completions` message. */
export type ChatJsonMessage = Record<string, unknown>;

export const CHAT_JSON_DEFAULT_MAX_TOKENS = 8000;
export const CHAT_JSON_DEFAULT_TEMPERATURE = 0.65;
/** The first call plus one retry. */
export const CHAT_JSON_MAX_ATTEMPTS = 2;

/** The first attempt's messages: the system prompt, then the images (if any) ahead of the user prompt. */
export function chatJsonMessages(request: ChatJsonRequest): ChatJsonMessage[] {
  const images = request.images ?? [];
  const userContent = images.length > 0
    ? [
      ...images.map(url => ({ type: 'image_url', image_url: { url } })),
      { type: 'text', text: request.userPrompt },
    ]
    : request.userPrompt;

  return [
    { role: 'system', content: request.systemPrompt },
    { role: 'user', content: userContent },
  ];
}

/** The `/chat/completions` body for one attempt over `messages`. */
export function chatJsonBody(request: ChatJsonRequest, messages: ChatJsonMessage[]): Record<string, unknown> {
  const veniceParameters = request.disableThinking
    ? { disable_thinking: true, strip_thinking_response: true }
    : undefined;
  return {
    model: request.model,
    messages,
    max_tokens: request.maxTokens ?? CHAT_JSON_DEFAULT_MAX_TOKENS,
    temperature: request.temperature ?? CHAT_JSON_DEFAULT_TEMPERATURE,
    ...(veniceParameters ? { venice_parameters: veniceParameters } : {}),
  };
}

/** What one reply means. */
export type ChatJsonStep<T> =
  | { kind: 'ok'; value: T }
  /** Ask again with `messages`, the whole conversation for the next attempt. `error` is what went wrong with this one. */
  | { kind: 'retry'; messages: ChatJsonMessage[]; error: Error }
  | { kind: 'error'; error: Error };

/**
 * Decide what attempt `attempt` (0-based) over `messages` does with the
 * reply's text content (`''` when there was none).
 *
 * An empty reply is retried with the same messages, since vision models drop
 * replies intermittently; a second empty reply is an error naming the
 * no-vision cause. A reply that does not parse after fence stripping is
 * retried once with the model's own output and the parser's complaint
 * appended; a second parse failure is an error quoting the last complaint.
 */
export function chatJsonStep<T>(
  request: ChatJsonRequest,
  attempt: number,
  messages: ChatJsonMessage[],
  raw: string,
): ChatJsonStep<T> {
  const { model, images = [], label = 'response' } = request;
  const maxTokens = request.maxTokens ?? CHAT_JSON_DEFAULT_MAX_TOKENS;
  const canRetry = attempt + 1 < CHAT_JSON_MAX_ATTEMPTS;

  if (!raw.trim()) {
    const error = new Error(
      images.length > 0
        ? `${model} returned no content for the ${label}. Either the model cannot read images (no-vision models answer image prompts with silence rather than an error) or it dropped this response intermittently -- retried once before giving up.`
        : `${model} returned no content for the ${label}. It may have spent the whole ${maxTokens}-token budget reasoning.`,
    );
    // Intermittent empties happen even on vision models.
    return canRetry ? { kind: 'retry', messages, error } : { kind: 'error', error };
  }

  const cleaned = extractJsonBlock(raw);
  try {
    return { kind: 'ok', value: JSON.parse(cleaned) as T };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    if (!canRetry) {
      return {
        kind: 'error',
        error: new Error(`${model} did not return valid JSON for the ${label} after a retry: ${error.message}`),
      };
    }
    // Hand the model its own broken output plus the parser's complaint.
    return {
      kind: 'retry',
      error,
      messages: [
        ...messages,
        { role: 'assistant', content: raw },
        {
          role: 'user',
          content: `That did not parse as JSON: ${error.message}. Return the same content again as one valid JSON document. No prose, no markdown fences.`,
        },
      ],
    };
  }
}
