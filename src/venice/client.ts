// ---------------------------------------------------------------------------
// VeniceClient -- low-level HTTP transport for the Venice AI REST API.
//
// Handles authentication, serialisation, retries with exponential back-off,
// and a simple inter-request rate-limit delay.
// ---------------------------------------------------------------------------

import { extractJsonBlock } from "venice-video-harness/core/venice/json-block.js";
import { abortableSleep, currentSignal, isAbortError } from "./operation-context.js";

// ---- Configuration constants ----------------------------------------------

const DEFAULT_BASE_URL = "https://api.venice.ai";
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1_000; // 1 s
const RATE_LIMIT_DELAY_MS = 250; // 250 ms between requests

// ---- Custom error ---------------------------------------------------------

export class VeniceRequestError extends Error {
  public readonly status: number;
  public readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "VeniceRequestError";
    this.status = status;
    this.body = body;
  }
}

// ---- Request options -------------------------------------------------------

export interface PostOptions {
  /**
   * Retry transient failures (HTTP 429, 5xx, network errors) with back-off.
   * Defaults to `true`. Set `false` for non-idempotent calls where a retry
   * could duplicate a side effect that the first attempt already caused.
   */
  retry?: boolean;
}

// ---- Error message extraction ----------------------------------------------

/**
 * Pull the human-readable reason out of a Venice error body.
 *
 * The API uses three shapes depending on where the request failed, and reading
 * only `error.message` -- as this client used to -- threw away the two most
 * useful ones:
 *
 *   {"error": {"message": "..."}}                     upstream provider error
 *   {"error": "Specified model not found: x. Did      routing error, including
 *              you mean: a, b, c?"}                   the suggestion list
 *   {"issues": [{"message": "Image content is not     request validation
 *              supported by this model..."}]}
 *
 * Losing those turned "this model cannot see images" into a bare HTTP 400.
 */
export function describeApiError(errorBody: unknown, status: number): string {
  const body = errorBody as {
    error?: string | { message?: string };
    issues?: Array<{ message?: string }>;
    detail?: string;
  } | null | undefined;

  if (typeof body?.error === 'string' && body.error.trim()) return body.error;
  if (typeof body?.error === 'object' && body.error?.message) return body.error.message;

  const issues = (body?.issues ?? [])
    .map(issue => issue?.message)
    .filter((message): message is string => Boolean(message && message.trim()));
  if (issues.length > 0) return issues.join('; ');

  if (typeof body?.detail === 'string' && body.detail.trim()) return body.detail;
  return `Venice API returned HTTP ${status}`;
}

// ---- JSON extraction --------------------------------------------------------

export { extractJsonBlock };

// ---- chatJson reply policy -------------------------------------------------

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

// ---- Deprecation header surfacing -----------------------------------------
//
// Venice returns these headers on every call that uses a deprecated model:
//
//   x-venice-model-id                            (the model actually served)
//   x-venice-model-name                          (display name)
//   x-venice-model-deprecation-warning           (free-form notice)
//   x-venice-model-deprecation-date              (ISO 8601 date)
//
// Source: https://docs.venice.ai/api-reference/api-spec (response headers).
//
// Before this change the client read JSON bodies and discarded headers,
// which meant the harness was completely blind to upcoming Venice model
// sunsets — a model would keep working with a "deprecation in N days"
// banner that we never saw, and then start 404ing post-sunset with no
// warning. (This is exactly what happened with `qwen-2.5-vl` for the QA
// vision model: the model sunset 2025-09-22 and the harness only learned
// about it via downstream 404s.)
//
// We surface each unique (model, date) deprecation warning ONCE per
// process via stderr so the MCP can pattern-match `MODEL DEPRECATION` and
// the agent operating the pipeline can plan a migration before the sunset
// date. The dedupe key includes the date so a model whose sunset is
// rescheduled re-warns.

const seenDeprecations = new Set<string>();

export interface VeniceDeprecationNotice {
  modelId: string | null;
  modelName: string | null;
  warning: string;
  date: string | null;
}

/**
 * Inspect a Response's headers for Venice deprecation notices and emit
 * a structured stderr warning the first time each unique notice is seen
 * in this process. Returns the parsed notice when present (mostly for
 * testing), otherwise null.
 *
 * Exported for tests; callers in this file invoke it from each request
 * path so every response shape (json, binary, json-or-binary) is covered.
 */
export function reportVeniceDeprecation(
  headers: Headers,
  requestPath: string,
): VeniceDeprecationNotice | null {
  const warning = headers.get("x-venice-model-deprecation-warning");
  if (!warning) return null;

  const date = headers.get("x-venice-model-deprecation-date");
  const modelId = headers.get("x-venice-model-id");
  const modelName = headers.get("x-venice-model-name");

  const dedupeKey = `${modelId ?? "(unknown)"}::${date ?? "(no-date)"}`;
  if (!seenDeprecations.has(dedupeKey)) {
    seenDeprecations.add(dedupeKey);
    const id = modelId ?? "(unknown id)";
    const name = modelName ? ` "${modelName}"` : "";
    const when = date ? ` sunset ${date}` : "";
    console.warn(
      `  ⚠ MODEL DEPRECATION: ${id}${name}${when} (via ${requestPath}): ${warning}`,
    );
    console.warn(
      `    Migrate before the sunset date or this call will start returning 404 / 410.`,
    );
    console.warn(
      `    Check the current recommended replacement via inspect.models (MCP) ` +
        `or GET https://api.venice.ai/api/v1/models for the model's traits.`,
    );
  }

  return { modelId, modelName, warning, date };
}

/**
 * Test-only: reset the per-process deduplication state so unit tests can
 * exercise the warn-once behavior across multiple invocations.
 */
export function _resetDeprecationDedupeForTests(): void {
  seenDeprecations.clear();
}

// ---- Client ---------------------------------------------------------------

export class VeniceClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  /**
   * Timestamp (epoch ms) of the last request that completed.  Used by the
   * simple rate-limiter to ensure a minimum gap between consecutive calls.
   */
  private lastRequestAt = 0;

  /**
   * @param apiKey  Bearer token for the Venice API.  Falls back to the
   *                `VENICE_API_KEY` environment variable when omitted.
   * @param baseUrl Root URL for the API (no trailing slash).
   */
  constructor(apiKey?: string, baseUrl?: string) {
    const resolvedKey = apiKey ?? process.env.VENICE_API_KEY;
    if (!resolvedKey) {
      throw new Error(
        "Venice API key is required. Pass it explicitly or set the VENICE_API_KEY environment variable.",
      );
    }
    this.apiKey = resolvedKey;
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  // ---- Public API ---------------------------------------------------------

  /** Send a GET request and return parsed JSON. Used by setup/doctor checks. */
  async get<T = unknown>(path: string): Promise<T> {
    await this.applyRateLimit();
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal: currentSignal(),
    });
    this.lastRequestAt = Date.now();
    reportVeniceDeprecation(response.headers, path);
    if (response.ok) return (await response.json()) as T;

    let errorBody: unknown;
    try {
      errorBody = await response.json();
    } catch {
      errorBody = { raw: await response.text().catch(() => '') };
    }
    throw new VeniceRequestError(
      describeApiError(errorBody, response.status),
      response.status,
      errorBody,
    );
  }

  /**
   * Send a POST request to `path` with a JSON body and return the parsed
   * response.
   *
   * Automatically retries on transient failures (HTTP 429 / 5xx) up to
   * {@link MAX_RETRIES} times using exponential back-off.  A small delay is
   * inserted between consecutive requests to stay within rate limits.
   *
   * Pass `{ retry: false }` for calls that are not idempotent. `POST
   * /video/queue` is the case that matters: Venice may have accepted and
   * billed the job before the 5xx (or a dropped connection) reached us, so a
   * blind retry can queue -- and pay for -- the same shot twice. With retries
   * off the first failure surfaces as-is and the caller decides.
   *
   * @typeParam T  Expected shape of the parsed JSON response.
   * @param path   API path **including** the leading slash (e.g. `/api/v1/image/generate`).
   * @param body   Request payload -- will be JSON-stringified.
   * @param options.retry  Retry 429/5xx/network errors (default `true`).
   * @returns      Parsed JSON response body.
   * @throws {VeniceRequestError} On non-retryable HTTP errors (4xx other than 429).
   * @throws {Error}              When all retry attempts are exhausted.
   */
  async post<T = unknown>(
    path: string,
    body: Record<string, unknown>,
    options: PostOptions = {},
  ): Promise<T> {
    await this.applyRateLimit();

    const url = `${this.baseUrl}${path}`;
    const maxAttempts = options.retry === false ? 1 : MAX_RETRIES;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        await abortableSleep(backoff);
      }

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: currentSignal(),
        });

        this.lastRequestAt = Date.now();
        reportVeniceDeprecation(response.headers, path);

        if (response.ok) {
          return (await response.json()) as T;
        }

        // Parse the error body for diagnostics.
        let errorBody: unknown;
        try {
          errorBody = await response.json();
        } catch {
          errorBody = { raw: await response.text().catch(() => "") };
        }

        const message = describeApiError(errorBody, response.status);

        // Retry on rate-limit (429) and server errors (5xx).
        if (response.status === 429 || response.status >= 500) {
          if (response.status === 429 && maxAttempts > 1) {
            console.warn(
              `  ⚠ Venice rate-limit (HTTP 429) on ${path}; retrying with exponential back-off (attempt ${attempt + 1}/${maxAttempts}).`,
            );
          }
          lastError = new VeniceRequestError(message, response.status, errorBody);
          continue;
        }

        // 410 Gone usually means the model has been removed post-sunset and
        // routing wasn't possible — surface it explicitly so the agent
        // doesn't just see a generic 4xx.
        if (response.status === 410) {
          console.warn(
            `  ⚠ Venice returned 410 Gone on ${path}. The requested model is likely fully retired ` +
              `and Venice could not route to a replacement. Check the deprecation tracker or call ` +
              `GET /api/v1/models to find the current equivalent.`,
          );
        }

        // Non-retryable client error -- throw immediately.
        throw new VeniceRequestError(message, response.status, errorBody);
      } catch (err) {
        // Cancellation is not a transient failure -- never retry it.
        if (isAbortError(err)) throw err;
        // Network errors (DNS failure, connection reset, etc.) are retryable.
        if (err instanceof VeniceRequestError) {
          // Already classified above; re-throw non-retryable errors.
          if (err.status > 0 && err.status < 500 && err.status !== 429) {
            throw err;
          }
          lastError = err;
        } else {
          lastError = err instanceof Error ? err : new Error(String(err));
        }
      }
    }

    throw lastError ?? new Error("Venice API request failed after all retries.");
  }

  /**
   * POST with JSON body, receive raw binary (e.g. image/png from multi-edit).
   * Same retry/rate-limit logic as {@link post}.
   */
  async postBinary(path: string, body: Record<string, unknown>): Promise<Buffer> {
    await this.applyRateLimit();

    const url = `${this.baseUrl}${path}`;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        await abortableSleep(backoff);
      }

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: currentSignal(),
        });

        this.lastRequestAt = Date.now();
        reportVeniceDeprecation(response.headers, path);

        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          return Buffer.from(arrayBuffer);
        }

        let errorBody: unknown;
        try {
          errorBody = await response.json();
        } catch {
          errorBody = { raw: await response.text().catch(() => "") };
        }

        const message = describeApiError(errorBody, response.status);

        if (response.status === 429 || response.status >= 500) {
          lastError = new VeniceRequestError(message, response.status, errorBody);
          continue;
        }

        throw new VeniceRequestError(message, response.status, errorBody);
      } catch (err) {
        if (isAbortError(err)) throw err;
        if (err instanceof VeniceRequestError) {
          if (err.status > 0 && err.status < 500 && err.status !== 429) {
            throw err;
          }
          lastError = err;
        } else {
          lastError = err instanceof Error ? err : new Error(String(err));
        }
      }
    }

    throw lastError ?? new Error("Venice API request failed after all retries.");
  }

  /**
   * POST with JSON body, receive either JSON status data or raw binary media.
   * Useful for async retrieval endpoints that return JSON while processing and
   * switch to binary once the asset is ready for download.
   */
  async postBinaryOrJson<T = unknown>(
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ contentType: string; value: T | Buffer }> {
    await this.applyRateLimit();

    const url = `${this.baseUrl}${path}`;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1);
        await abortableSleep(backoff);
      }

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: currentSignal(),
        });

        this.lastRequestAt = Date.now();
        reportVeniceDeprecation(response.headers, path);

        if (response.ok) {
          const contentType = response.headers.get("content-type") ?? "";
          if (contentType.includes("application/json")) {
            return {
              contentType,
              value: (await response.json()) as T,
            };
          }

          return {
            contentType,
            value: Buffer.from(await response.arrayBuffer()),
          };
        }

        let errorBody: unknown;
        try {
          errorBody = await response.json();
        } catch {
          errorBody = { raw: await response.text().catch(() => "") };
        }

        const message = describeApiError(errorBody, response.status);

        if (response.status === 429 || response.status >= 500) {
          lastError = new VeniceRequestError(message, response.status, errorBody);
          continue;
        }

        throw new VeniceRequestError(message, response.status, errorBody);
      } catch (err) {
        if (isAbortError(err)) throw err;
        if (err instanceof VeniceRequestError) {
          if (err.status > 0 && err.status < 500 && err.status !== 429) {
            throw err;
          }
          lastError = err;
        } else {
          lastError = err instanceof Error ? err : new Error(String(err));
        }
      }
    }

    throw lastError ?? new Error("Venice API request failed after all retries.");
  }

  /**
   * Send a chat completion request with multimodal content (text + images).
   * Uses the OpenAI-compatible chat completions endpoint.
   */
  async chatWithVision(
    model: string,
    systemPrompt: string,
    imageDataUris: string[],
    userPrompt: string,
    maxTokens = 4000,
  ): Promise<string> {
    const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [];
    for (const uri of imageDataUris) {
      content.push({ type: 'image_url', image_url: { url: uri } });
    }
    content.push({ type: 'text', text: userPrompt });

    const body = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content },
      ],
      // Reasoning models spend part of this budget thinking, and what is left
      // over is the visible answer. Too low and `content` comes back empty.
      max_tokens: maxTokens,
      temperature: 0.3,
    };

    const response = await this.post<{
      choices: Array<{ message: { content: string } }>;
    }>('/api/v1/chat/completions', body as unknown as Record<string, unknown>);

    return response.choices?.[0]?.message?.content ?? '';
  }

  /**
   * Chat completion that must come back as JSON, with one corrective retry.
   *
   * Every reasoning step in the harness -- workshop, script, storyboard QA --
   * asks for JSON and parses the reply. Three things make that fragile, and
   * this handles all of them in one place:
   *
   *  - Models fence their JSON in ```json blocks inconsistently.
   *  - A model can emit *almost* valid JSON. GLM 5.2 drops a closing brace
   *    roughly one attempt in three, which used to fail the whole command.
   *    A single retry quoting the parse error fixes it.
   *  - A model with no real vision returns EMPTY content rather than an error
   *    when handed an image, which reads as an unhelpful parse failure. That
   *    case is named explicitly so the operator can change models.
   *  - A model WITH vision can still return empty content intermittently
   *    (kimi-k3 did this on 4 of 12 storyboard-QA panels, 2026-08-10, while
   *    reading the other 8 fine). Empty content therefore consumes a retry
   *    attempt instead of failing immediately; only a repeat emptiness throws.
   *
   * Reasoning text arrives in a separate `reasoning_content` field on every
   * model checked, so it never pollutes what gets parsed.
   */
  async chatJson<T>(options: ChatJsonRequest): Promise<T> {
    let messages = chatJsonMessages(options);
    for (let attempt = 0; ; attempt++) {
      const response = await this.post<{
        choices: Array<{ message: { content: string | null } }>;
      }>('/api/v1/chat/completions', chatJsonBody(options, messages));

      const raw = response.choices?.[0]?.message?.content ?? '';
      const step = chatJsonStep<T>(options, attempt, messages, raw);
      if (step.kind === 'ok') return step.value;
      if (step.kind === 'error') throw step.error;
      messages = step.messages;
    }
  }

  // ---- Internals ----------------------------------------------------------

  /**
   * Ensure at least {@link RATE_LIMIT_DELAY_MS} ms have elapsed since the
   * previous request completed.
   */
  private async applyRateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < RATE_LIMIT_DELAY_MS) {
      await abortableSleep(RATE_LIMIT_DELAY_MS - elapsed);
    }
  }
}
