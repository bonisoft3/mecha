// The models an app's AI tiers resolve to, per release target, and the keys
// each provider reads: what tsbifrost.ts calls with, and what a release reads
// to know which secrets its effects need, without loading the gateway.

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
  /** Merged into the provider call for this model only: an override that
   * names another model leaves them behind. */
  params?: Record<string, unknown>;
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
  targets?: Partial<Record<AiTarget, AiModalityMap<AiModelOverride | AiRoutedOverride>>>;
};

/** A deployment's choice among declared models: `env[secret]` names one of
 * `routes` at each call, so one release calls Gemini from production and
 * Workers AI from staging. */
export type AiRoutedOverride = { secret: string; routes: Record<string, AiModelOverride> };

const GEMMA_4_NO_THINKING = { chat_template_kwargs: { enable_thinking: false } };

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
      // Thinking, Gemma 4 spent its whole budget before answering: a deck's words took 32 s
      // where they take 5 s without, past the airlock's 45 s bound once the deck is long.
      cheap: { provider: "cloudflare", model: "@cf/google/gemma-4-26b-a4b-it", params: GEMMA_4_NO_THINKING },
      heavy: { provider: "cloudflare", model: "@cf/google/gemma-4-26b-a4b-it", params: GEMMA_4_NO_THINKING },
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

/** `spec` moved to `model`, leaving its params behind when the model changes. */
function forModel(spec: AiModelSpec, model: string): AiModelSpec {
  if (model === spec.model) return { ...spec };
  const { params: _left, ...rest } = spec;
  return { ...rest, model };
}

function applyOverride(base: AiModelSpec, override?: AiModelOverride): AiModelSpec {
  if (!override) return { ...base };
  if (typeof override === "string") return forModel(base, override);
  return {
    ...forModel(base, override.model ?? base.model),
    ...(override.provider !== undefined ? { provider: override.provider } : {}),
    ...(override.endpoint !== undefined ? { endpoint: override.endpoint } : {}),
    ...(override.size !== undefined ? { size: override.size } : {}),
    ...(override.steps !== undefined ? { steps: override.steps } : {}),
    ...(override.params !== undefined ? { params: override.params } : {}),
  };
}

function isRouted(override: AiModelOverride | AiRoutedOverride | undefined): override is AiRoutedOverride {
  return typeof override === "object" && "routes" in override;
}

// The value is never echoed: a key put in the wrong secret would land in the log.
function routed(override: AiModelOverride | AiRoutedOverride | undefined, env: Record<string, string | undefined>): AiModelOverride | undefined {
  if (!isRouted(override)) return override;
  const names = Object.keys(override.routes).join(", ");
  const value = env[override.secret];
  if (!value) throw new Error(`AI setting ${override.secret} is not set on this deployment: it names one of ${names}`);
  if (!Object.hasOwn(override.routes, value)) throw new Error(`AI setting ${override.secret} is not one of ${names}`);
  return override.routes[value];
}

/** Resolves the concrete model specification for `(target, modality, tier)`
 * after layering global tier overrides (`config.models`), release-target
 * overrides (`config.targets[target]`, a routed one by the deployment's
 * setting in `env`), and environment overrides. */
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
  const withTarget = applyOverride(withGlobal, routed(config?.targets?.[target]?.[modality]?.[tier], env));

  const envPrefix = `AI_${modality.toUpperCase()}_${tier.toUpperCase()}`;
  const envModel = env[`${envPrefix}_MODEL`];
  const envEndpoint = env[`${envPrefix}_ENDPOINT`];
  const envProvider = env[`${envPrefix}_PROVIDER`] as AiProvider | undefined;
  const envSize = env[`${envPrefix}_SIZE`];
  const envSteps = env[`${envPrefix}_STEPS`];

  return {
    ...forModel(withTarget, envModel || withTarget.model),
    ...(envProvider ? { provider: envProvider } : {}),
    ...(envEndpoint ? { endpoint: envEndpoint } : {}),
    ...(envSize ? { size: envSize } : {}),
    ...(envSteps && Number.isInteger(Number(envSteps)) ? { steps: Number(envSteps) } : {}),
  };
}

/** The environment a provider's key is read from, the first set name
 * serving. Workers AI answers through its binding, and local providers need
 * no key. */
export const PROVIDER_KEYS: Partial<Record<AiProvider, readonly string[]>> = {
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  openai: ["OPENAI_API_KEY"],
};

export function providerKey(provider: AiProvider, env: Record<string, string | undefined>): string {
  for (const name of PROVIDER_KEYS[provider] ?? []) if (env[name]) return env[name]!;
  return "";
}

function backendTiers(config: AiCapabilitiesConfig | undefined): [AiModality, AiBackendTier][] {
  return (["text", "image"] as const).flatMap((modality) =>
    (config?.[modality] ?? []).flatMap((tier): [AiModality, AiBackendTier][] => tier === "browser" ? [] : [[modality, tier]])
  );
}

function keyGroups(specs: AiModelSpec[]): string[][] {
  const groups = new Map<AiProvider, string[]>();
  for (const { provider } of specs) if (PROVIDER_KEYS[provider]) groups.set(provider, [...PROVIDER_KEYS[provider]!]);
  return [...groups.values()];
}

/** The keys a target's calls read whatever its deployment selects, as
 * resolveModelSpec resolves every backend tier the config declares and no
 * setting routes: one group per provider, any of whose names serves. */
export function providerKeyGroups(config: AiCapabilitiesConfig | undefined, target: AiTarget): string[][] {
  return keyGroups(
    backendTiers(config)
      .filter(([modality, tier]) => !isRouted(config?.targets?.[target]?.[modality]?.[tier]))
      .map(([modality, tier]) => resolveModelSpec(config, target, modality, tier)),
  );
}

/** Each setting a target's routed tiers read, and the key groups each of its
 * routes needs. A setting shared by tiers declares the same routes in each,
 * or a value one accepts the other refuses. */
export function routedSettings(config: AiCapabilitiesConfig | undefined, target: AiTarget): Record<string, Record<string, string[][]>> {
  const settings = new Map<string, Map<string, AiModelSpec[]>>();
  for (const [modality, tier] of backendTiers(config)) {
    const override = config?.targets?.[target]?.[modality]?.[tier];
    if (!isRouted(override)) continue;
    const names = Object.keys(override.routes).sort();
    if (names.length === 0) throw new Error(`AI setting ${override.secret} routes ${modality} ${tier} nowhere`);
    const known = settings.get(override.secret);
    if (known && [...known.keys()].join() !== names.join()) {
      throw new Error(`AI setting ${override.secret} routes ${modality} ${tier} by ${names.join(", ")} and another tier by ${[...known.keys()].join(", ")}`);
    }
    const routes = known ?? new Map(names.map((name) => [name, [] as AiModelSpec[]]));
    for (const name of names) routes.get(name)!.push(resolveModelSpec(config, target, modality, tier, { [override.secret]: name }));
    settings.set(override.secret, routes);
  }
  return Object.fromEntries([...settings].map(([secret, routes]) => [secret, Object.fromEntries([...routes].map(([name, specs]) => [name, keyGroups(specs)]))]));
}

/** The model a call to `(modality, tier)` runs, refused when the deployment's
 * setting routes that tier to a provider whose key it does not hold: read for
 * the call alone, so an unkeyed route blocks only the work that takes it. */
export function resolveCallSpec(
  config: AiCapabilitiesConfig | undefined,
  target: AiTarget,
  modality: AiModality,
  tier: AiTier,
  env: Record<string, string | undefined>,
): AiModelSpec {
  const spec = resolveModelSpec(config, target, modality, tier, env);
  const override = tier === "browser" ? undefined : config?.targets?.[target]?.[modality]?.[tier];
  const keys = PROVIDER_KEYS[spec.provider];
  if (isRouted(override) && keys && !keys.some((name) => env[name])) {
    throw new Error(`AI setting ${override.secret} routes ${modality} ${tier} to ${spec.provider}, which reads ${keys.join(" or ")}, and this deployment holds none`);
  }
  return spec;
}
