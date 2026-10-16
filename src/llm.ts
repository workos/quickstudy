/**
 * The one seam between quickstudy and the model provider: a tiny
 * structured-output client interface, an Anthropic-backed implementation,
 * and a validate-with-one-re-ask helper.
 *
 * Every host-side LLM call goes through this seam, so tests mock a single
 * interface and never touch the network. Design rules:
 *   - The provider client owns transport retries (3x on 429/5xx/connection).
 *   - Structured output is requested via `output_config.format` json_schema,
 *     so parsing never fails silently; a schema-invalid response gets exactly
 *     ONE re-ask with the error appended, then becomes a hard
 *     `ModelOutputError` the caller handles per its own error contract.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { parseHeaderLines } from "./secrets.ts";

/** One structured-output request. `schema` is a JSON Schema object. */
export interface StructuredRequest {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  /** JSON Schema the response must satisfy (objects need additionalProperties:false). */
  schema: Record<string, unknown>;
}

/** The seam tests mock. Returns the model's raw text response. */
export interface StructuredModelClient {
  requestStructured(request: StructuredRequest): Promise<string>;
  /**
   * The model id the provider reported for the most recent response, when
   * known — provenance for artifacts (a pinned alias may resolve elsewhere).
   */
  resolvedModel?(): string | null;
}

/** The model responded, but not with schema-valid output (after one re-ask). */
export class ModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelOutputError";
  }
}

/** Spec: retry API failures 3x before surfacing them. */
const API_MAX_RETRIES = 3;

/**
 * Anthropic-backed client. Reuses ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL
 * from the environment (the SDK reads both), plus ANTHROPIC_CUSTOM_HEADERS
 * (`Name: Value` lines — Claude Code's convention) as default headers, so the
 * analyst takes the same route as the agent CLI when both are pointed at an
 * LLM gateway. Transport-level retries are the SDK's (429/5xx/connection
 * errors).
 */
export class AnthropicModelClient implements StructuredModelClient {
  private readonly client: Anthropic;
  private lastResolvedModel: string | null = null;

  constructor(options: { apiKey?: string; baseURL?: string; defaultHeaders?: Record<string, string> } = {}) {
    const defaultHeaders = options.defaultHeaders ?? parseHeaderLines(process.env["ANTHROPIC_CUSTOM_HEADERS"]);
    this.client = new Anthropic({
      ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
      ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
      ...(Object.keys(defaultHeaders).length > 0 ? { defaultHeaders } : {}),
      maxRetries: API_MAX_RETRIES,
    });
  }

  resolvedModel(): string | null {
    return this.lastResolvedModel;
  }

  async requestStructured(request: StructuredRequest): Promise<string> {
    const response = await this.client.messages.create({
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: [{ role: "user", content: request.user }],
      output_config: { format: { type: "json_schema", schema: request.schema } },
    });
    this.lastResolvedModel = response.model;

    if (response.stop_reason === "refusal") {
      throw new ModelOutputError(`model refused the request (model: ${request.model})`);
    }
    if (response.stop_reason === "max_tokens") {
      throw new ModelOutputError(
        `model output truncated at ${request.maxTokens} tokens (model: ${request.model})`,
      );
    }

    const text = response.content.find((block) => block.type === "text")?.text;
    if (text === undefined) {
      throw new ModelOutputError(`model returned no text content (model: ${request.model})`);
    }
    return text;
  }
}

/**
 * Request + parse + zod-validate, with exactly one re-ask on invalid output:
 * the retry prompt appends the previous (bad) response and the validation
 * error. A second failure is a hard ModelOutputError — never a silent skip.
 */
export async function requestValidated<T>(
  client: StructuredModelClient,
  request: StructuredRequest,
  schema: z.ZodType<T>,
): Promise<T> {
  const attempt = (raw: string): { ok: true; value: T } | { ok: false; error: string } => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { ok: false, error: `response is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
    const result = schema.safeParse(parsed);
    if (result.success) return { ok: true, value: result.data };
    return { ok: false, error: `response does not match the schema: ${result.error.message}` };
  };

  const first = attempt(await client.requestStructured(request));
  if (first.ok) return first.value;

  const reasked = attempt(
    await client.requestStructured({
      ...request,
      user:
        `${request.user}\n\n` +
        `Your previous response was invalid — ${first.error}\n` +
        `Respond again with ONLY a JSON object that matches the required schema exactly.`,
    }),
  );
  if (reasked.ok) return reasked.value;

  throw new ModelOutputError(`model output invalid after one re-ask: ${reasked.error}`);
}
