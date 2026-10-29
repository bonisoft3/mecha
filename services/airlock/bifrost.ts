import { whiteBackgroundBase64 } from "./white-background.ts";
// The AI gateway bridge (bifrost): OpenAI-compatible HTTP from the airlock's
// daprd in, tier-and-target-routed model calls out.
//
// An app declares its modalities and tiers in `capabilities.ai`, with optional
// per-tier or per-target model overrides. Effect handlers inside the airlock
// cage speak a single normalized contract:
//   - POST /v1/chat/completions   ({ tier: "cheap" | "heavy", messages, ... })
//   - POST /v1/images/generations ({ tier: "cheap" | "heavy", prompt, ... })
//   - GET  /v1/models
//   - GET  /healthz
//
// Bifrost resolves (target, modality, tier) to the concrete provider, model,
// endpoint, image dimensions, and step budget, translates the wire payload for
// Ollama, sd.cpp, Cloudflare Workers AI, Google Gemini / Imagen, or OpenAI,
// and returns a normalized OpenAI-shaped response with `model` and `tier`.

export type AiModality = "text" | "image";
export type AiTier = "browser" | "cheap" | "heavy";
export type AiBackendTier = "cheap" | "heavy";
export type AiTarget = "browser" | "pages" | "docker" | "local" | "cloudflare" | "gcp" | "k8s" | "aws";
export type AiProvider = "browser" | "ollama" | "sdcpp" | "cloudflare" | "google" | "openai";

export type AiModelSpec = {
  provider: AiProvider;
  model: string;
  endpoint?: string;
  size?: string;
  steps?: number;
};

export type AiModelOverride = string | Partial<AiModelSpec>;

export type AiTierMap<T = AiModelSpec> = {
  browser?: T;
  cheap?: T;
  heavy?: T;
};

export type AiModalityMap<T = AiModelSpec> = {
  text?: AiTierMap<T>;
  image?: AiTierMap<T>;
};

export type AiCapabilitiesConfig = {
  text?: AiTier[];
  image?: AiTier[];
  models?: AiModalityMap<AiModelOverride>;
  targets?: Partial<Record<AiTarget, AiModalityMap<AiModelOverride>>>;
};

export const BIFROST_PORT = 8090;

export const DEFAULT_AI_MODELS: Record<AiTarget, Record<AiModality, Record<AiTier, AiModelSpec>>> = {
  browser: {
    text: {
      browser: { provider: "browser", model: "HuggingFaceTB/SmolLM2-135M-Instruct" },
      cheap: { provider: "browser", model: "HuggingFaceTB/SmolLM2-135M-Instruct" },
      heavy: { provider: "browser", model: "HuggingFaceTB/SmolLM2-135M-Instruct" },
    },
    image: {
      browser: { provider: "browser", model: "procedural-svg", size: "256x256", steps: 1 },
      cheap: { provider: "browser", model: "procedural-svg", size: "256x256", steps: 1 },
      heavy: { provider: "browser", model: "procedural-svg", size: "512x512", steps: 2 },
    },
  },
  pages: {
    text: {
      browser: { provider: "browser", model: "HuggingFaceTB/SmolLM2-135M-Instruct" },
      cheap: { provider: "browser", model: "HuggingFaceTB/SmolLM2-135M-Instruct" },
      heavy: { provider: "browser", model: "HuggingFaceTB/SmolLM2-135M-Instruct" },
    },
    image: {
      browser: { provider: "browser", model: "procedural-svg", size: "256x256", steps: 1 },
      cheap: { provider: "browser", model: "procedural-svg", size: "256x256", steps: 1 },
      heavy: { provider: "browser", model: "procedural-svg", size: "512x512", steps: 2 },
    },
  },
  docker: {
    text: {
      browser: { provider: "browser", model: "google/gemma-4-e2b-it" },
      cheap: { provider: "ollama", model: "smollm3:latest", endpoint: "http://smollm3:11434" },
      heavy: { provider: "ollama", model: "smollm3:latest", endpoint: "http://smollm3:11434" },
    },
    image: {
      browser: { provider: "browser", model: "procedural-svg-sketch", size: "256x256", steps: 1 },
      cheap: { provider: "sdcpp", model: "sd-turbo-q4_0", endpoint: "http://diffusion:8000", size: "256x256", steps: 1 },
      heavy: { provider: "sdcpp", model: "sd-turbo-q8_0", endpoint: "http://diffusion:8000", size: "512x512", steps: 2 },
    },
  },
  local: {
    text: {
      browser: { provider: "browser", model: "google/gemma-4-e2b-it" },
      cheap: { provider: "ollama", model: "gemma4:e4b", endpoint: "http://127.0.0.1:11434" },
      heavy: { provider: "ollama", model: "gemma4:26b", endpoint: "http://127.0.0.1:11434" },
    },
    image: {
      browser: { provider: "browser", model: "procedural-svg-sketch", size: "256x256", steps: 1 },
      cheap: { provider: "sdcpp", model: "sd-turbo-q8_0", endpoint: "http://127.0.0.1:8000", size: "512x512", steps: 1 },
      heavy: { provider: "sdcpp", model: "flux1-schnell-q4_k", endpoint: "http://127.0.0.1:8000", size: "512x512", steps: 4 },
    },
  },
  cloudflare: {
    text: {
      browser: { provider: "browser", model: "google/gemma-4-e2b-it" },
      cheap: { provider: "cloudflare", model: "@cf/google/gemma-4-26b-a4b-it" },
      heavy: { provider: "cloudflare", model: "@cf/google/gemma-4-26b-a4b-it" },
    },
    image: {
      browser: { provider: "browser", model: "procedural-svg-sketch", size: "256x256", steps: 1 },
      cheap: { provider: "cloudflare", model: "@cf/black-forest-labs/flux-1-schnell", size: "512x512", steps: 2 },
      heavy: { provider: "cloudflare", model: "@cf/leonardo/phoenix-1.0", size: "512x512", steps: 20 },
    },
  },
  gcp: {
    text: {
      browser: { provider: "browser", model: "google/gemma-4-e2b-it" },
      cheap: { provider: "google", model: "gemma-4-26b-a4b-it" },
      heavy: { provider: "google", model: "gemma-4-31b-it" },
    },
    image: {
      browser: { provider: "browser", model: "procedural-svg-sketch", size: "256x256", steps: 1 },
      cheap: { provider: "google", model: "imagen-4.0-fast-generate-001", size: "512x512", steps: 2 },
      heavy: { provider: "google", model: "imagen-4.0-ultra-generate-001", size: "1024x1024", steps: 4 },
    },
  },
  k8s: {
    text: {
      browser: { provider: "browser", model: "google/gemma-4-e2b-it" },
      cheap: { provider: "google", model: "gemma-4-26b-a4b-it" },
      heavy: { provider: "google", model: "gemma-4-31b-it" },
    },
    image: {
      browser: { provider: "browser", model: "procedural-svg-sketch", size: "256x256", steps: 1 },
      cheap: { provider: "google", model: "imagen-4.0-fast-generate-001", size: "512x512", steps: 2 },
      heavy: { provider: "google", model: "imagen-4.0-ultra-generate-001", size: "1024x1024", steps: 4 },
    },
  },
  aws: {
    text: {
      browser: { provider: "browser", model: "google/gemma-4-e2b-it" },
      cheap: { provider: "google", model: "gemma-4-26b-a4b-it" },
      heavy: { provider: "google", model: "gemma-4-31b-it" },
    },
    image: {
      browser: { provider: "browser", model: "procedural-svg-sketch", size: "256x256", steps: 1 },
      cheap: { provider: "google", model: "imagen-4.0-fast-generate-001", size: "512x512", steps: 2 },
      heavy: { provider: "google", model: "imagen-4.0-ultra-generate-001", size: "1024x1024", steps: 4 },
    },
  },
};

function applyOverride(base: AiModelSpec, override?: AiModelOverride): AiModelSpec {
  if (!override) return { ...base };
  if (typeof override === "string") return { ...base, model: override };
  return {
    provider: override.provider ?? base.provider,
    model: override.model ?? base.model,
    ...(override.endpoint !== undefined ? { endpoint: override.endpoint } : base.endpoint !== undefined ? { endpoint: base.endpoint } : {}),
    ...(override.size !== undefined ? { size: override.size } : base.size !== undefined ? { size: base.size } : {}),
    ...(override.steps !== undefined ? { steps: override.steps } : base.steps !== undefined ? { steps: base.steps } : {}),
  };
}

/** Resolves the concrete model specification for `(target, modality, tier)`
 * after layering global tier overrides (`config.models`), release-target
 * overrides (`config.targets[target]`), and environment overrides. */
export function resolveModelSpec(
  config: AiCapabilitiesConfig | undefined,
  target: AiTarget,
  modality: AiModality,
  tier: AiTier,
  env: Record<string, string | undefined> = {},
): AiModelSpec {
  const targetTable = DEFAULT_AI_MODELS[target] ?? DEFAULT_AI_MODELS.docker;
  const base = targetTable[modality][tier];
  const withGlobal = applyOverride(base, config?.models?.[modality]?.[tier]);
  const withTarget = applyOverride(withGlobal, config?.targets?.[target]?.[modality]?.[tier]);

  const envPrefix = `AI_${modality.toUpperCase()}_${tier.toUpperCase()}`;
  const envModel = env[`${envPrefix}_MODEL`];
  const envEndpoint = env[`${envPrefix}_ENDPOINT`];
  const envProvider = env[`${envPrefix}_PROVIDER`] as AiProvider | undefined;
  const envSize = env[`${envPrefix}_SIZE`];
  const envSteps = env[`${envPrefix}_STEPS`];

  return {
    ...withTarget,
    ...(envProvider ? { provider: envProvider } : {}),
    ...(envModel ? { model: envModel } : {}),
    ...(envEndpoint ? { endpoint: envEndpoint } : {}),
    ...(envSize ? { size: envSize } : {}),
    ...(envSteps && Number.isInteger(Number(envSteps)) ? { steps: Number(envSteps) } : {}),
  };
}

export interface CloudflareAiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export type BifrostOptions = {
  target?: AiTarget;
  config?: AiCapabilitiesConfig;
  env?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
  aiBinding?: CloudflareAiBinding;
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isTier(v: unknown): v is AiBackendTier {
  return v === "cheap" || v === "heavy";
}

export function createBifrost(opts: BifrostOptions = {}): (req: Request) => Promise<Response> {
  const env = opts.env ?? (typeof Deno !== "undefined" ? Deno.env.toObject() : {});
  const rawTarget = (opts.target ?? env.AI_TARGET ?? env.SAYT_PLATFORM ?? "docker") as AiTarget;
  const target: AiTarget = rawTarget in DEFAULT_AI_MODELS ? rawTarget : "docker";
  const config: AiCapabilitiesConfig = opts.config ?? (env.AI_MODELS ? JSON.parse(env.AI_MODELS) : {});
  const fetcher = opts.fetcher ?? fetch;
  const aiBinding = opts.aiBinding;

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/health")) {
      return json(200, { status: "ok", target });
    }

    if (req.method === "POST" && url.pathname.startsWith("/v1.0/bindings/")) {
      let envelope: {
        operation?: string;
        data?: unknown;
        metadata?: Record<string, string>;
      };
      try {
        envelope = (await req.json()) as typeof envelope;
      } catch {
        return json(400, { error: "invalid Dapr binding JSON" });
      }
      const meta = envelope.metadata ?? {};
      const subPath = typeof meta.path === "string" && meta.path.startsWith("/") ? meta.path : "/v1/models";
      const method = (envelope.operation || "post").toUpperCase();
      const headers = new Headers({ "content-type": "application/json" });
      for (const [k, v] of Object.entries(meta)) {
        if (k !== "path" && typeof v === "string") headers.set(k, v);
      }
      const innerReq = new Request(`http://bifrost:${BIFROST_PORT}${subPath}`, {
        method,
        headers,
        ...(method !== "GET" && method !== "HEAD" && envelope.data !== undefined
          ? { body: typeof envelope.data === "string" ? envelope.data : JSON.stringify(envelope.data) }
          : {}),
      });
      const innerRes = await handle(innerReq);
      const bodyText = await innerRes.text();
      const ct = innerRes.headers.get("content-type") ?? "application/json";
      return new Response(bodyText, {
        status: 200,
        headers: {
          "content-type": ct,
          "metadata.statuscode": String(innerRes.status),
          "metadata.content-type": ct,
        },
      });
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      const tiers: AiTier[] = ["browser", "cheap", "heavy"];
      const modalities: AiModality[] = ["text", "image"];
      const data = modalities.flatMap((modality) =>
        tiers.map((tier) => {
          const spec = resolveModelSpec(config, target, modality, tier, env);
          return {
            id: `${modality}:${tier}`,
            object: "model",
            modality,
            tier,
            target,
            ...spec,
          };
        })
      );
      return json(200, { object: "list", target, data });
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return json(400, { error: "invalid JSON body" });
      }
      const tier: AiBackendTier = isTier(body.tier) ? body.tier : "cheap";
      const messages = body.messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        return json(400, { error: "messages array is required" });
      }
      const spec = resolveModelSpec(config, target, "text", tier, env);
      const model = typeof body.model === "string" && body.model !== "" && body.model !== "auto"
        ? body.model
        : spec.model;
      const idempotencyKey = req.headers.get("idempotency-key") ?? "";

      try {
        const content = await dispatchText(
          target,
          spec,
          model,
          messages as Array<{ role: string; content: string }>,
          body,
          idempotencyKey,
          env,
          fetcher,
          aiBinding,
        );
        return json(200, {
          id: `chatcmpl-${idempotencyKey || "bifrost"}`,
          object: "chat.completion",
          model,
          tier,
          provider: spec.provider,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content },
              finish_reason: "stop",
            },
          ],
        });
      } catch (e) {
        console.error(`bifrost chat/completions error (${spec.provider}/${model}/${tier}):`, e instanceof Error ? e.stack ?? e.message : String(e));
        if (e instanceof UpstreamError) {
          return json(e.status, { error: e.message, provider: spec.provider, model, tier });
        }
        return json(503, { error: e instanceof Error ? e.message : String(e), provider: spec.provider, model, tier });
      }
    }

    if (req.method === "POST" && url.pathname === "/v1/images/generations") {
      let body: Record<string, unknown>;
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        return json(400, { error: "invalid JSON body" });
      }
      const tier: AiBackendTier = isTier(body.tier) ? body.tier : "cheap";
      const prompt = body.prompt;
      if (typeof prompt !== "string" || prompt.trim() === "") {
        return json(400, { error: "prompt string is required" });
      }
      const spec = resolveModelSpec(config, target, "image", tier, env);
      const model = typeof body.model === "string" && body.model !== "" && body.model !== "auto"
        ? body.model
        : spec.model;
      const size = typeof body.size === "string" && body.size !== "" ? body.size : (spec.size ?? "256x256");
      const steps = typeof body.steps === "number" ? body.steps : (spec.steps ?? 1);
      const idempotencyKey = req.headers.get("idempotency-key") ?? "";

      try {
        const rawImage = await dispatchImage(
          target,
          spec,
          model,
          prompt,
          size,
          steps,
          body,
          idempotencyKey,
          env,
          fetcher,
          aiBinding,
        );
        const b64_json = body.background === "white" ? whiteBackgroundBase64(rawImage) : rawImage;
        return json(200, {
          model,
          tier,
          provider: spec.provider,
          size,
          steps,
          data: [{ b64_json }],
        });
      } catch (e) {
        console.error(`bifrost chat/completions error (${spec.provider}/${model}/${tier}):`, e instanceof Error ? e.stack ?? e.message : String(e));
        if (e instanceof UpstreamError) {
          return json(e.status, { error: e.message, provider: spec.provider, model, tier });
        }
        return json(503, { error: e instanceof Error ? e.message : String(e), provider: spec.provider, model, tier });
      }
    }

    return json(404, { error: "not found" });
  };
  return handle;
}

class UpstreamError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function dispatchText(
  target: AiTarget,
  spec: AiModelSpec,
  model: string,
  messages: Array<{ role: string; content: string }>,
  body: Record<string, unknown>,
  idempotencyKey: string,
  env: Record<string, string | undefined>,
  fetcher: typeof fetch,
  aiBinding?: CloudflareAiBinding,
): Promise<string> {
  const temperature = typeof body.temperature === "number" ? body.temperature : 0.2;
  const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : 384;
  const seed = typeof body.seed === "number" ? body.seed : undefined;
  const rf = (typeof body.response_format === "object" && body.response_format !== null)
    ? (body.response_format as { type?: string; schema?: unknown; json_schema?: unknown })
    : undefined;
  const jsonSchema = rf?.type === "json_schema" ? rf.json_schema ?? rf.schema : undefined;
  const wantsJson = body.format === "json" || rf?.type === "json_object" || Boolean(jsonSchema);

  if (spec.provider === "ollama") {
    const rawEndpoint = spec.endpoint ?? env.OLLAMA_HOST ?? "http://smollm3:11434";
    const endpoint = (
      target === "local" && env.AI_LOCAL_OLLAMA_HOST && rawEndpoint.includes("127.0.0.1")
        ? env.AI_LOCAL_OLLAMA_HOST
        : rawEndpoint
    ).replace(/\/$/, "");
    const res = await fetcher(`${endpoint}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify({
        model,
        stream: false,
        ...(jsonSchema ? { format: jsonSchema } : wantsJson ? { format: "json" } : {}),
        options: {
          temperature,
          num_predict: maxTokens,
          ...(seed !== undefined ? { seed } : {}),
        },
        messages,
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new UpstreamError(res.status, `ollama ${res.status}: ${text}`);
    const parsed = JSON.parse(text) as {
      message?: { content?: string };
      response?: string;
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = parsed.message?.content ?? parsed.response ?? parsed.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new UpstreamError(502, "ollama response missing message.content");
    return content;
  }

  if (spec.provider === "cloudflare") {
    const responseFormat = jsonSchema ? { type: "json_schema", json_schema: jsonSchema } : { type: "json_object" };
    if (aiBinding && !spec.endpoint && !env.CF_API_TOKEN) {
      const extractText = (out: unknown): string | undefined => {
        if (typeof out === "string" && out.trim() !== "") return out;
        if (out && typeof out === "object") {
          const o = out as {
            response?: unknown;
            result?: {
              response?: unknown;
              choices?: Array<{ message?: { content?: unknown; reasoning_content?: string }; text?: string }>;
            };
            choices?: Array<{ message?: { content?: unknown; reasoning_content?: string }; text?: string }>;
          };
          if (o.response !== undefined && o.response !== null) {
            if (typeof o.response === "string" && o.response.trim() !== "") return o.response;
            if (typeof o.response === "object") return JSON.stringify(o.response);
          }
          if (o.result?.response !== undefined && o.result?.response !== null) {
            if (typeof o.result.response === "string" && o.result.response.trim() !== "") return o.result.response;
            if (typeof o.result.response === "object") return JSON.stringify(o.result.response);
          }
          const msg = o.choices?.[0]?.message ?? o.result?.choices?.[0]?.message;
          const rawContent = msg?.content;
          const partText = Array.isArray(rawContent)
            ? rawContent.map((p: any) => (typeof p === "string" ? p : p?.text ?? "")).join("")
            : typeof rawContent === "string"
            ? rawContent
            : rawContent && typeof rawContent === "object"
            ? JSON.stringify(rawContent)
            : undefined;
          const cand = (partText && partText.trim() !== "" ? partText : undefined) ??
            o.choices?.[0]?.text ??
            o.result?.choices?.[0]?.text ??
            msg?.reasoning_content;
          if (typeof cand === "string" && cand.trim() !== "") return cand;
        }
        return undefined;
      };
      const candidateModels = model.includes("gemma-4")
        ? ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/google/gemma-3-12b-it", "@cf/meta/llama-3.1-8b-instruct-fast", model]
        : [model, "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/google/gemma-3-12b-it", "@cf/meta/llama-3.1-8b-instruct-fast"];
      const textErrors: string[] = [];
      for (const m of candidateModels) {
        try {
          const out = await aiBinding.run(m, {
            messages,
            max_tokens: Math.max(maxTokens, 1024),
            temperature,
            ...(wantsJson ? { response_format: responseFormat } : {}),
            ...(seed !== undefined ? { seed } : {}),
          });
          const content = extractText(out);
          if (typeof content === "string") return content;
          textErrors.push(`${m}: non-string ${JSON.stringify(out)?.slice(0, 400)}`);
        } catch (err) {
          textErrors.push(`${m}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      throw new UpstreamError(502, `cloudflare AI binding response missing response (${textErrors.join(" | ")})`);
    }
    const accountId = env.CF_ACCOUNT_ID ?? "";
    const token = env.CF_API_TOKEN ?? "";
    const base = (spec.endpoint ?? `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`).replace(/\/$/, "");
    const res = await fetcher(`${base}/${model}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify({
        messages,
        max_tokens: maxTokens,
        temperature,
        ...(wantsJson ? { response_format: responseFormat } : {}),
        ...(seed !== undefined ? { seed } : {}),
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new UpstreamError(res.status, `cloudflare ${res.status}: ${text}`);
    const parsed = JSON.parse(text) as {
      result?: { response?: unknown };
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = parsed.result?.response ?? parsed.choices?.[0]?.message?.content;
    if (wantsJson && content !== null && typeof content === "object") return JSON.stringify(content);
    if (typeof content !== "string") throw new UpstreamError(502, "cloudflare response missing result.response");
    return content;
  }

  if (spec.provider === "google") {
    const apiKey = env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY ?? "";
    const base = (spec.endpoint ?? "https://generativelanguage.googleapis.com/v1beta/models").replace(/\/$/, "");
    const systemParts = messages.filter((m) => m.role === "system").map((m) => ({ text: m.content }));
    const contents = messages.filter((m) => m.role !== "system").map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
    const res = await fetcher(`${base}/${model}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { "x-goog-api-key": apiKey } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify({
        ...(systemParts.length > 0 ? { systemInstruction: { parts: systemParts } } : {}),
        contents: contents.length > 0 ? contents : [{ role: "user", parts: systemParts }],
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
          ...(wantsJson ? { responseMimeType: "application/json" } : {}),
          ...(seed !== undefined ? { seed } : {}),
        },
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new UpstreamError(res.status, `google ${res.status}: ${text}`);
    const parsed = JSON.parse(text) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = parsed.candidates?.[0]?.content?.parts?.[0]?.text ?? parsed.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new UpstreamError(502, "google response missing candidate text");
    return content;
  }

  // OpenAI-compatible fallback
  const endpoint = (spec.endpoint ?? "http://127.0.0.1:8080").replace(/\/$/, "");
  const res = await fetcher(`${endpoint}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(env.OPENAI_API_KEY ? { authorization: `Bearer ${env.OPENAI_API_KEY}` } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      ...(wantsJson ? { response_format: { type: "json_object" } } : {}),
      ...(seed !== undefined ? { seed } : {}),
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new UpstreamError(res.status, `openai ${res.status}: ${text}`);
  const parsed = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
  const content = parsed.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new UpstreamError(502, "openai response missing choices[0].message.content");
  return content;
}

async function dispatchImage(
  target: AiTarget,
  spec: AiModelSpec,
  model: string,
  prompt: string,
  size: string,
  steps: number,
  body: Record<string, unknown>,
  idempotencyKey: string,
  env: Record<string, string | undefined>,
  fetcher: typeof fetch,
  aiBinding?: CloudflareAiBinding,
): Promise<string> {
  const seed = typeof body.seed === "number" ? body.seed : undefined;
  const negativePrompt = typeof body.negative_prompt === "string" ? body.negative_prompt : undefined;

  if (spec.provider === "cloudflare") {
    if (aiBinding && !spec.endpoint && !env.CF_API_TOKEN) {
      const extractImageB64 = async (out: unknown): Promise<string | undefined> => {
        if (out && typeof out === "object" && ("image" in out || "result" in out || "data" in out)) {
          const obj = out as { image?: string; result?: { image?: string }; data?: Array<{ b64_json?: string }> };
          const b64 = obj.image ?? obj.result?.image ?? obj.data?.[0]?.b64_json;
          if (typeof b64 === "string" && b64 !== "") return b64;
        }
        if (out instanceof Uint8Array || out instanceof ArrayBuffer || (out && typeof (out as ReadableStream).getReader === "function")) {
          const bytes = out instanceof Uint8Array
            ? out
            : out instanceof ArrayBuffer
            ? new Uint8Array(out)
            : new Uint8Array(await new Response(out as BodyInit).arrayBuffer());
          let bin = "";
          for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          }
          if (bin !== "") return btoa(bin);
        }
        return undefined;
      };
      const runCfImageModel = async (m: string): Promise<string | undefined> => {
        if (m.includes("flux-2")) {
          const form = new FormData();
          form.append("prompt", prompt);
          form.append("steps", String(steps));
          if (seed !== undefined) form.append("seed", String(seed));
          const req = new Response(form);
          const contentType = req.headers.get("content-type") || "multipart/form-data";
          const out = await aiBinding.run(m, {
            multipart: { body: req.body, contentType },
          });
          return extractImageB64(out);
        }
        if (m.includes("leonardo/")) {
          const [wStr, hStr] = size.split("x");
          const width = Math.min(Math.max(Number(wStr) || 512, 256), 512);
          const height = Math.min(Math.max(Number(hStr) || 512, 256), 512);
          const out = await aiBinding.run(m, {
            prompt,
            width,
            height,
            num_steps: steps,
            ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
            ...(seed !== undefined ? { seed } : {}),
          });
          return extractImageB64(out);
        }
        const out = await aiBinding.run(m, {
          prompt,
          steps: Math.min(Math.max(steps, 1), 8),
        });
        return extractImageB64(out);
      };
      const b64 = await runCfImageModel(model);
      if (b64) return b64;
      throw new UpstreamError(502, `cloudflare AI binding response missing image (${model})`);
    }
    const accountId = env.CF_ACCOUNT_ID ?? "";
    const token = env.CF_API_TOKEN ?? "";
    const base = (spec.endpoint ?? `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`).replace(/\/$/, "");
    const res = await fetcher(`${base}/${model}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify({
        prompt,
        num_steps: steps,
        ...(seed !== undefined ? { seed } : {}),
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new UpstreamError(res.status, `cloudflare ${res.status}: ${text}`);
    const parsed = JSON.parse(text) as {
      result?: { image?: string };
      data?: Array<{ b64_json?: string }>;
    };
    const b64 = parsed.result?.image ?? parsed.data?.[0]?.b64_json;
    if (typeof b64 !== "string" || b64 === "") throw new UpstreamError(502, "cloudflare response missing image base64");
    return b64;
  }

  if (spec.provider === "google") {
    const apiKey = env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY ?? "";
    const base = (spec.endpoint ?? "https://generativelanguage.googleapis.com/v1beta/models").replace(/\/$/, "");
    if (model.startsWith("gemini-")) {
      const res = await fetcher(`${base}/${model}:generateContent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(apiKey ? { "x-goog-api-key": apiKey } : {}),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ["IMAGE"] },
        }),
      });
      const text = await res.text();
      if (!res.ok) throw new UpstreamError(res.status, `google ${res.status}: ${text}`);
      const parsed = JSON.parse(text) as {
        candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> } }>;
      };
      const parts = parsed.candidates?.[0]?.content?.parts ?? [];
      const b64 = parts.find((p) => typeof p?.inlineData?.data === "string" && p.inlineData.data !== "")?.inlineData?.data;
      if (typeof b64 !== "string" || b64 === "") throw new UpstreamError(502, "google response missing inlineData.data");
      return b64;
    }
    const res = await fetcher(`${base}/${model}:predict`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { "x-goog-api-key": apiKey } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: {
          sampleCount: 1,
          ...(seed !== undefined ? { seed } : {}),
        },
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new UpstreamError(res.status, `google ${res.status}: ${text}`);
    const parsed = JSON.parse(text) as {
      predictions?: Array<{ bytesBase64Encoded?: string }>;
      data?: Array<{ b64_json?: string }>;
    };
    const b64 = parsed.predictions?.[0]?.bytesBase64Encoded ?? parsed.data?.[0]?.b64_json;
    if (typeof b64 !== "string" || b64 === "") throw new UpstreamError(502, "google response missing bytesBase64Encoded");
    return b64;
  }

  // sd.cpp / OpenAI-compatible /v1/images/generations
  const rawEndpoint = spec.endpoint ?? env.SDCPP_HOST ?? "http://diffusion:8000";
  const endpoint = (
    target === "local" && env.AI_LOCAL_SDCPP_HOST && rawEndpoint.includes("127.0.0.1")
      ? env.AI_LOCAL_SDCPP_HOST
      : rawEndpoint
  ).replace(/\/$/, "");
  const res = await fetcher(`${endpoint}/v1/images/generations`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify({
      model,
      prompt,
      ...(negativePrompt !== undefined ? { negative_prompt: negativePrompt } : {}),
      n: typeof body.n === "number" ? body.n : 1,
      size,
      steps,
      response_format: "b64_json",
      ...(seed !== undefined ? { seed } : {}),
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new UpstreamError(res.status, `sdcpp ${res.status}: ${text}`);
  const parsed = JSON.parse(text) as {
    data?: Array<{ b64_json?: string }>;
    image?: string;
  };
  const b64 = parsed.data?.[0]?.b64_json ?? parsed.image;
  if (typeof b64 !== "string" || b64 === "") throw new UpstreamError(502, "sdcpp response missing b64_json");
  return b64;
}

if (import.meta.main) {
  const port = Number(Deno.env.get("BIFROST_PORT") ?? BIFROST_PORT);
  Deno.serve({ hostname: "0.0.0.0", port }, createBifrost());
}
