import assert from "node:assert/strict";
import {
  type AiCapabilitiesConfig,
  resolveCallSpec,
  createTsBifrost,
  DEFAULT_AI_MODELS,
  mergeExtra,
  PASSTHROUGH_HEADER,
  providerKey,
  providerKeyGroups,
  resolveModelSpec,
  routedSettings,
} from "./tsbifrost.ts";

Deno.test("default 3-tier model lineup resolves per release target", () => {
  // pages / browser: CPU-friendly SmolLM2-135M + procedural SVG
  assert.equal(resolveModelSpec(undefined, "pages", "text", "browser").model, "HuggingFaceTB/SmolLM2-135M-Instruct");
  assert.equal(resolveModelSpec(undefined, "browser", "text", "browser").model, "HuggingFaceTB/SmolLM2-135M-Instruct");
  assert.equal(resolveModelSpec(undefined, "pages", "image", "browser").model, "procedural-svg");

  // docker: Gemma-4-E2B in browser, smollm3 in container, degraded sd-turbo-q4_0 (cheap) & sd-turbo-q8_0 (heavy)
  assert.equal(resolveModelSpec(undefined, "docker", "text", "browser").model, "google/gemma-4-e2b-it");
  assert.equal(resolveModelSpec(undefined, "docker", "text", "cheap").model, "smollm3:latest");
  assert.equal(resolveModelSpec(undefined, "docker", "image", "cheap").model, "sd-turbo-q4_0");
  assert.equal(resolveModelSpec(undefined, "docker", "image", "cheap").size, "256x256");
  assert.equal(resolveModelSpec(undefined, "docker", "image", "cheap").steps, 1);
  assert.equal(resolveModelSpec(undefined, "docker", "image", "heavy").model, "sd-turbo-q8_0");
  assert.equal(resolveModelSpec(undefined, "docker", "image", "heavy").size, "512x512");
  assert.equal(resolveModelSpec(undefined, "docker", "image", "heavy").steps, 2);

  // local: host Metal Ollama (gemma4:e4b / gemma4:26b) + Metal sd.cpp (sd-turbo-q8_0 / flux1-schnell-q4_k)
  assert.equal(resolveModelSpec(undefined, "local", "text", "cheap").model, "gemma4:e4b");
  assert.equal(resolveModelSpec(undefined, "local", "text", "heavy").model, "gemma4:26b");
  assert.equal(resolveModelSpec(undefined, "local", "image", "cheap").model, "sd-turbo-q8_0");
  assert.equal(resolveModelSpec(undefined, "local", "image", "heavy").model, "flux1-schnell-q4_k");

  // cloudflare: Workers AI gemma-4-26b-a4b-it + flux-1-schnell (cheap) / phoenix-1.0 (heavy)
  assert.equal(resolveModelSpec(undefined, "cloudflare", "text", "cheap").model, "@cf/google/gemma-4-26b-a4b-it");
  assert.equal(resolveModelSpec(undefined, "cloudflare", "image", "cheap").model, "@cf/black-forest-labs/flux-1-schnell");
  assert.equal(resolveModelSpec(undefined, "cloudflare", "image", "heavy").model, "@cf/leonardo/phoenix-1.0");

  // gcp / k8s: gemma-4-26b-a4b-it / gemma-4-31b-it + imagen-4.0-fast / imagen-4.0-ultra
  assert.equal(resolveModelSpec(undefined, "gcp", "text", "cheap").model, "gemma-4-26b-a4b-it");
  assert.equal(resolveModelSpec(undefined, "gcp", "text", "heavy").model, "gemma-4-31b-it");
  assert.equal(resolveModelSpec(undefined, "gcp", "image", "cheap").model, "imagen-4.0-fast-generate-001");
  assert.equal(resolveModelSpec(undefined, "gcp", "image", "heavy").model, "imagen-4.0-ultra-generate-001");
});

Deno.test("global tier overrides, release-target overrides, and env overrides layer in priority order", () => {
  const config: AiCapabilitiesConfig = {
    models: {
      text: {
        heavy: "gemma4:31b-global",
      },
      image: {
        cheap: { model: "custom-sd-fast", size: "384x384", steps: 2 },
      },
    },
    targets: {
      local: {
        text: {
          heavy: { model: "gemma4:31b-metal", endpoint: "http://127.0.0.1:11435" },
        },
      },
    },
  };

  // Global override applies on docker
  const dockerHeavy = resolveModelSpec(config, "docker", "text", "heavy");
  assert.equal(dockerHeavy.model, "gemma4:31b-global");
  assert.equal(dockerHeavy.provider, "ollama");

  const dockerCheapImg = resolveModelSpec(config, "docker", "image", "cheap");
  assert.equal(dockerCheapImg.model, "custom-sd-fast");
  assert.equal(dockerCheapImg.size, "384x384");
  assert.equal(dockerCheapImg.steps, 2);

  // Target override wins over global override on local
  const localHeavy = resolveModelSpec(config, "local", "text", "heavy");
  assert.equal(localHeavy.model, "gemma4:31b-metal");
  assert.equal(localHeavy.endpoint, "http://127.0.0.1:11435");

  // Environment variable override wins over both
  const envOverridden = resolveModelSpec(config, "local", "text", "heavy", {
    AI_TEXT_HEAVY_MODEL: "gemma4:env-override",
  });
  assert.equal(envOverridden.model, "gemma4:env-override");
  assert.equal(envOverridden.endpoint, "http://127.0.0.1:11435");
});

Deno.test("tsbifrost normalizes chat completions and image generations across providers", async () => {
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, headers, body });

    if (url.endsWith("/api/chat")) {
      return new Response(JSON.stringify({ message: { content: '{"cards":["Cavalo"]}' } }), { status: 200 });
    }
    if (url.endsWith("/v1/images/generations")) {
      return new Response(JSON.stringify({ data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUg==" }] }), { status: 200 });
    }
    if (url.includes("api.cloudflare.com") && url.includes("gemma")) {
      return new Response(JSON.stringify({ result: { response: '{"cards":["Boto"]}' } }), { status: 200 });
    }
    if (url.includes("generativelanguage.googleapis.com") && url.endsWith(":predict")) {
      return new Response(JSON.stringify({ predictions: [{ bytesBase64Encoded: "R0lGODlhAQABAAAAACw=" }] }), { status: 200 });
    }
    return new Response("unexpected upstream", { status: 500 });
  };

  // 1. Docker target (Ollama + sd.cpp)
  const dockerGateway = createTsBifrost({ target: "docker", fetcher: fakeFetch });

  const chatRes = await dockerGateway(
    new Request("http://tsbifrost:8090/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "draft:1" },
      body: JSON.stringify({
        tier: "cheap",
        format: "json",
        seed: 42,
        messages: [{ role: "user", content: "animais" }],
      }),
    }),
  );
  assert.equal(chatRes.status, 200);
  const chatBody = await chatRes.json();
  assert.equal(chatBody.model, DEFAULT_AI_MODELS.docker.text.cheap.model);
  assert.equal(chatBody.tier, "cheap");
  assert.equal(chatBody.choices[0].message.content, '{"cards":["Cavalo"]}');
  assert.equal(calls[0].url, "http://smollm3:11434/api/chat");
  assert.equal(calls[0].headers["idempotency-key"], "draft:1");

  const imgRes = await dockerGateway(
    new Request("http://tsbifrost:8090/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "img:1" },
      body: JSON.stringify({
        tier: "heavy",
        prompt: "Montessori horse card",
      }),
    }),
  );
  assert.equal(imgRes.status, 200);
  const imgBody = await imgRes.json();
  assert.equal(imgBody.model, "sd-turbo-q8_0");
  assert.equal(imgBody.tier, "heavy");
  assert.equal(imgBody.size, "512x512");
  assert.equal(imgBody.steps, 2);
  assert.equal(imgBody.data[0].b64_json, "iVBORw0KGgoAAAANSUhEUg==");

  // 2. Cloudflare target (Workers AI)
  const cfGateway = createTsBifrost({
    target: "cloudflare",
    env: { CF_ACCOUNT_ID: "acc123", CF_API_TOKEN: "tok456" },
    fetcher: fakeFetch,
  });
  const cfChatRes = await cfGateway(
    new Request("http://tsbifrost:8090/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier: "cheap", messages: [{ role: "user", content: "fauna" }] }),
    }),
  );
  assert.equal(cfChatRes.status, 200);
  const cfChatBody = await cfChatRes.json();
  assert.equal(cfChatBody.model, "@cf/google/gemma-4-26b-a4b-it");
  assert.equal(cfChatBody.choices[0].message.content, '{"cards":["Boto"]}');

  // 3. GCP target (Imagen 4 Ultra)
  const gcpGateway = createTsBifrost({
    target: "gcp",
    env: { GEMINI_API_KEY: "gem-key" },
    fetcher: fakeFetch,
  });
  const gcpImgRes = await gcpGateway(
    new Request("http://tsbifrost:8090/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier: "heavy", prompt: "Montessori boto card" }),
    }),
  );
  assert.equal(gcpImgRes.status, 200);
  const gcpImgBody = await gcpImgRes.json();
  assert.equal(gcpImgBody.model, "imagen-4.0-ultra-generate-001");
  assert.equal(gcpImgBody.size, "1024x1024");
  assert.equal(gcpImgBody.data[0].b64_json, "R0lGODlhAQABAAAAACw=");

  // 4. Local target via SAYT_PLATFORM + AI_LOCAL_OLLAMA_HOST + json_schema forwarding
  const localGateway = createTsBifrost({
    env: {
      SAYT_PLATFORM: "host",
      AI_LOCAL_OLLAMA_HOST: "http://host.docker.internal:11434",
      AI_LOCAL_SDCPP_HOST: "http://host.docker.internal:8000",
    },
    fetcher: fakeFetch,
  });
  const schemaObj = { type: "object", properties: { cards: { type: "array" } } };
  const localChatRes = await localGateway(
    new Request("http://tsbifrost:8090/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tier: "heavy",
        response_format: { type: "json_schema", schema: schemaObj },
        messages: [{ role: "user", content: "danças do mundo" }],
      }),
    }),
  );
  assert.equal(localChatRes.status, 200);
  const lastCall = calls[calls.length - 1];
  assert.equal(lastCall.url, "http://host.docker.internal:11434/api/chat");
  assert.deepEqual((lastCall.body as Record<string, unknown>).format, schemaObj);

  // 5. The invocation the airlock sends its mesh, for shared-localhost Cloud Run
  const daprBindingRes = await gcpGateway(
    new Request("http://127.0.0.1:8090/v1.0/invoke/sdcpp-illustrate/method/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "dapr:1" },
      body: JSON.stringify({ tier: "heavy", prompt: "Montessori boto card" }),
    }),
  );
  assert.equal(daprBindingRes.status, 200);
  const daprBody = await daprBindingRes.json();
  assert.equal(daprBody.model, "imagen-4.0-ultra-generate-001");
  assert.equal(daprBody.data[0].b64_json, "R0lGODlhAQABAAAAACw=");
});

Deno.test("sayt's host and compose platforms run on the local and docker targets", async () => {
  for (const [platform, target] of [["host", "local"], ["compose", "docker"]]) {
    const res = await createTsBifrost({ env: { SAYT_PLATFORM: platform } })(new Request("http://tsbifrost:8090/healthz"));
    assert.deepEqual(await res.json(), { status: "ok", target });
  }
});

Deno.test("Cloudflare heavy images use Phoenix parameters and decode its binary stream", async () => {
  const calls: Array<{ model: string; input: Record<string, unknown> }> = [];
  const handler = createTsBifrost({
    target: "cloudflare",
    env: {},
    aiBinding: { run: async (model, input) => {
      calls.push({ model, input });
      return new Response(new Uint8Array([1, 2, 3])).body;
    } },
  });
  const res = await handler(new Request("http://tsbifrost/v1/images/generations", {
    method: "POST",
    body: JSON.stringify({ tier: "heavy", prompt: "A cat", negative_prompt: "text", seed: 101 }),
  }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data[0].b64_json, "AQID");
  assert.deepEqual(calls, [{ model: "@cf/leonardo/phoenix-1.0", input: {
    prompt: "A cat", width: 512, height: 512, num_steps: 20, negative_prompt: "text", seed: 101,
  } }]);
});

Deno.test("Cloudflare rejects an empty Phoenix response without trying a different model", async () => {
  const models: string[] = [];
  const handler = createTsBifrost({ target: "cloudflare", env: {}, aiBinding: {
    run: async (model) => { models.push(model); return {}; },
  } });
  const res = await handler(new Request("http://tsbifrost/v1/images/generations", {
    method: "POST", body: JSON.stringify({ tier: "heavy", prompt: "A cat" }),
  }));
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /missing image/);
  assert.deepEqual(models, ["@cf/leonardo/phoenix-1.0"]);
});

// Thinking, Gemma 4 spent its whole token budget before answering: a deck's words took 32 s
// and past the airlock's 45 s call bound, so every attempt timed out and the deck stalled.
Deno.test("Cloudflare text asks Gemma 4 to answer without thinking, at the caller's token budget", async () => {
  const seen: { model: string; input: Record<string, unknown> }[] = [];
  const handler = createTsBifrost({ target: "cloudflare", env: {}, aiBinding: {
    run: async (model, input) => (seen.push({ model, input }), { response: "ok" }),
  } });
  for (const tier of ["cheap", "heavy"]) {
    const res = await handler(new Request("http://tsbifrost/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ tier, max_tokens: 512, messages: [{ role: "user", content: "Say ok" }] }),
    }));
    assert.equal(res.status, 200);
  }
  assert.deepEqual(seen.map(({ model, input }) => [model, input.chat_template_kwargs, input.max_tokens]), [
    ["@cf/google/gemma-4-26b-a4b-it", { enable_thinking: false }, 512],
    ["@cf/google/gemma-4-26b-a4b-it", { enable_thinking: false }, 512],
  ]);
});

for (const transport of ["binding", "rest"] as const) {
  Deno.test(`Cloudflare ${transport} preserves requested JSON mode without imposing it on ordinary text`, async () => {
    const calls: Record<string, unknown>[] = [];
    const handler = createTsBifrost({
      target: "cloudflare",
      env: transport === "rest" ? { CF_ACCOUNT_ID: "account", CF_API_TOKEN: "token" } : {},
      aiBinding: { run: async (_model, input) => {
        calls.push(input);
        return { response: '{"name":"חיות הקוטב","cards":["דוב קוטב"]}' };
      } },
      fetcher: async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        const response = { name: "חיות הקוטב", cards: ["דוב קוטב"] };
        return Response.json({ result: { response: (calls.at(-1)?.response_format as { type?: string })?.type === "json_schema" ? response : JSON.stringify(response) } });
      },
    });
    const schema = { type: "object", properties: { cards: { type: "array", items: { type: "string" } } }, required: ["cards"] };
    const cases = [
      [{ response_format: { type: "json_object" } }, { type: "json_object" }],
      [{ format: "json" }, { type: "json_object" }],
      [{ response_format: { type: "json_schema", json_schema: schema } }, { type: "json_schema", json_schema: schema }],
      [{}, undefined],
    ] as const;
    for (const [requested, expected] of cases) {
      const res = await handler(new Request("http://tsbifrost/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ tier: "cheap", messages: [{ role: "user", content: "Translate into Hebrew as JSON" }], ...requested }),
      }));
      assert.equal(res.status, 200);
      assert.deepEqual(calls.at(-1)?.response_format, expected);
      assert.equal(JSON.parse((await res.json()).choices[0].message.content).name, "חיות הקוטב");
    }
    assert.equal(calls.length, cases.length);
  });
}

// Every provider branch, so a branch that builds its body without mergeExtra
// drops extra_params silently, the failure Bifrost's contract exists to avoid.
const EXTRA = { guidance: 4, nested: { kept: true } };
const UPSTREAM = {
  message: { content: "ok" },
  result: { response: "ok", image: "AQID" },
  choices: [{ message: { content: "ok" } }],
  candidates: [{ content: { parts: [{ text: "ok", inlineData: { data: "AQID" } }] } }],
  predictions: [{ bytesBase64Encoded: "AQID" }],
  data: [{ b64_json: "AQID" }],
};
const BRANCHES: Array<{
  branch: string;
  path: "/v1/chat/completions" | "/v1/images/generations";
  target: "docker" | "cloudflare" | "gcp";
  tier?: "cheap" | "heavy";
  rest?: true;
  models?: AiCapabilitiesConfig["models"];
}> = [
  { branch: "text ollama", path: "/v1/chat/completions", target: "docker" },
  { branch: "text cloudflare binding", path: "/v1/chat/completions", target: "cloudflare" },
  { branch: "text cloudflare REST", path: "/v1/chat/completions", target: "cloudflare", rest: true },
  { branch: "text google", path: "/v1/chat/completions", target: "gcp" },
  { branch: "text openai", path: "/v1/chat/completions", target: "docker", models: { text: { cheap: { provider: "openai", model: "gpt-x", endpoint: "http://openai" } } } },
  { branch: "image cloudflare binding leonardo", path: "/v1/images/generations", target: "cloudflare", tier: "heavy" },
  { branch: "image cloudflare binding flux-2", path: "/v1/images/generations", target: "cloudflare", models: { image: { cheap: "@cf/black-forest-labs/flux-2-klein-4b" } } },
  { branch: "image cloudflare binding default", path: "/v1/images/generations", target: "cloudflare" },
  { branch: "image cloudflare REST", path: "/v1/images/generations", target: "cloudflare", tier: "heavy", rest: true },
  { branch: "image google gemini", path: "/v1/images/generations", target: "gcp", models: { image: { cheap: "gemini-2.5-flash-image" } } },
  { branch: "image google imagen", path: "/v1/images/generations", target: "gcp" },
  { branch: "image openai", path: "/v1/images/generations", target: "docker", models: { image: { cheap: { provider: "openai", model: "dall-x", endpoint: "http://openai" } } } },
  { branch: "image sd.cpp", path: "/v1/images/generations", target: "docker" },
];

function recordingGateway(b: (typeof BRANCHES)[number]) {
  const sent: Record<string, unknown>[] = [];
  const handler = createTsBifrost({
    target: b.target,
    config: { models: b.models },
    env: b.rest ? { CF_ACCOUNT_ID: "account", CF_API_TOKEN: "token" } : {},
    aiBinding: { run: async (_model, input) => {
      const multipart = input.multipart as { body: ReadableStream; contentType: string } | undefined;
      sent.push(multipart
        ? Object.fromEntries(await new Response(multipart.body, { headers: { "content-type": multipart.contentType } }).formData())
        : input);
      return { response: "ok", image: "AQID" };
    } },
    fetcher: async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json(UPSTREAM);
    },
  });
  return { handler, sent };
}

const ask = (b: (typeof BRANCHES)[number], extra: unknown, headers: Record<string, string>) =>
  new Request(`http://tsbifrost${b.path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      tier: b.tier ?? "cheap",
      ...(b.path === "/v1/chat/completions" ? { messages: [{ role: "user", content: "hi" }] } : { prompt: "A cat", negative_prompt: "text" }),
      extra_params: extra,
    }),
  });

for (const b of BRANCHES) {
  Deno.test(`${b.branch} forwards extra_params under the passthrough header`, async () => {
    const { handler, sent } = recordingGateway(b);
    const res = await handler(ask(b, EXTRA, { [PASSTHROUGH_HEADER]: "true" }));
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(sent.length, 1);
    const multipart = b.branch.includes("flux-2");
    assert.equal(sent[0].guidance, multipart ? "4" : 4);
    assert.deepEqual(sent[0].nested, multipart ? JSON.stringify(EXTRA.nested) : EXTRA.nested);
  });

  Deno.test(`${b.branch} refuses extra_params without the passthrough header`, async () => {
    const { handler, sent } = recordingGateway(b);
    const res = await handler(ask(b, EXTRA, {}));
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, new RegExp(`${PASSTHROUGH_HEADER}: true`));
    assert.equal(sent.length, 0);
  });
}

Deno.test("extra_params that are not an object are refused under the header too", async () => {
  const { handler, sent } = recordingGateway(BRANCHES[0]);
  const res = await handler(ask(BRANCHES[0], [1], { [PASSTHROUGH_HEADER]: "true" }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /must be an object/);
  assert.equal(sent.length, 0);
});

Deno.test("a field extra_params names wins; the fields beside it inside an object are kept", async () => {
  const google = BRANCHES.find((b) => b.branch === "text google")!;
  const { handler, sent } = recordingGateway(google);
  const res = await handler(ask(google, { generationConfig: { topK: 3, temperature: 0.9 } }, { [PASSTHROUGH_HEADER]: "true" }));
  assert.equal(res.status, 200);
  assert.deepEqual(sent[0].generationConfig, { temperature: 0.9, maxOutputTokens: 384, topK: 3 });
  assert.deepEqual(mergeExtra({ a: [1, 2], b: { c: 1 } }, { a: [3], b: 2 }), { a: [3], b: 2 });
});

Deno.test("the passthrough header rides an invocation like any other header", async () => {
  const leonardo = BRANCHES.find((b) => b.branch === "image cloudflare binding leonardo")!;
  const { handler, sent } = recordingGateway(leonardo);
  const res = await handler(new Request("http://127.0.0.1:8090/v1.0/invoke/illustrate-card/method/v1/images/generations", {
    method: "POST",
    headers: { "X-Bf-Passthrough-Extra-Params": "true" },
    body: JSON.stringify({ tier: "heavy", prompt: "A cat", extra_params: { guidance: 4 } }),
  }));
  assert.equal(res.status, 200);
  assert.equal(sent[0].guidance, 4);
});

// The REST path once sent Phoenix only the prompt, its steps and its seed, so
// the same model drew a different picture over REST than over the binding.
Deno.test("Cloudflare REST sends Phoenix the input the binding does", async () => {
  const input = async (rest: boolean) => {
    const { handler, sent } = recordingGateway({ branch: "phoenix", path: "/v1/images/generations", target: "cloudflare", tier: "heavy", ...(rest ? { rest: true } : {}) });
    const res = await handler(new Request("http://tsbifrost/v1/images/generations", {
      method: "POST",
      body: JSON.stringify({ tier: "heavy", prompt: "A cat", negative_prompt: "text", size: "384x320", seed: 7 }),
    }));
    assert.equal(res.status, 200);
    return sent[0];
  };
  const rest = await input(true);
  assert.deepEqual(rest, { prompt: "A cat", width: 384, height: 320, num_steps: 20, negative_prompt: "text", seed: 7 });
  assert.deepEqual(rest, await input(false));
});

// Phoenix's guidance is Phoenix's: sent to Imagen it is a 400 for an unknown
// field, so a model's params ride only to that model.
Deno.test("a model's params reach that model alone, and extra_params outrank them", async () => {
  const config: AiCapabilitiesConfig = {
    targets: { cloudflare: { image: { heavy: { model: "@cf/leonardo/phoenix-1.0", params: { guidance: 4 } } } } },
  };
  const sent = async (target: "cloudflare" | "gcp" | "docker", body: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const seen: Record<string, unknown>[] = [];
    const handler = createTsBifrost({
      target,
      config,
      env: {},
      aiBinding: { run: (_m, input) => (seen.push(input), Promise.resolve({ image: "AQID" })) },
      fetcher: (_u, init) => (seen.push(JSON.parse(String(init?.body))), Promise.resolve(Response.json(UPSTREAM))),
    });
    const res = await handler(new Request("http://tsbifrost/v1/images/generations", {
      method: "POST", headers, body: JSON.stringify({ tier: "heavy", prompt: "A cat", ...body }),
    }));
    assert.equal(res.status, 200);
    return seen[0];
  };
  assert.equal((await sent("cloudflare", {})).guidance, 4);
  assert.equal((await sent("gcp", {})).guidance, undefined);
  assert.equal((await sent("docker", {})).guidance, undefined);
  assert.equal((await sent("cloudflare", { model: "@cf/black-forest-labs/flux-1-schnell" })).guidance, undefined);
  assert.equal((await sent("cloudflare", { extra_params: { guidance: 6 } }, { [PASSTHROUGH_HEADER]: "true" })).guidance, 6);
});

Deno.test("an override that names another model leaves the params behind", () => {
  const config: AiCapabilitiesConfig = {
    models: { image: { heavy: { model: "@cf/leonardo/phoenix-1.0", params: { guidance: 4 } } } },
    targets: { cloudflare: { image: { heavy: { steps: 12 } } }, gcp: { image: { heavy: "imagen-4.0-fast-generate-001" } } },
  };
  assert.deepEqual(resolveModelSpec(config, "cloudflare", "image", "heavy").params, { guidance: 4 });
  assert.equal(resolveModelSpec(config, "gcp", "image", "heavy").params, undefined);
  assert.equal(resolveModelSpec(config, "cloudflare", "image", "heavy", { AI_IMAGE_HEAVY_MODEL: "@cf/other" }).params, undefined);
});

// The dispatcher's keys were read off `targets.cloudflare` alone: a global
// `models` override naming Google deployed a keyless dispatcher, and an app
// holding only GOOGLE_API_KEY, which the Google calls read too, was refused.
Deno.test("providerKeyGroups names the keys every declared tier's resolved provider reads", () => {
  assert.deepEqual(providerKeyGroups({ text: ["cheap"], image: ["heavy"] }, "cloudflare"), [], "Workers AI needs no key");
  assert.deepEqual(providerKeyGroups({ image: ["heavy"], models: { image: { heavy: { provider: "google", model: "imagen-4.0-ultra-generate-001" } } } }, "cloudflare"), [["GEMINI_API_KEY", "GOOGLE_API_KEY"]]);
  assert.deepEqual(providerKeyGroups({ text: ["cheap", "heavy"], targets: { cloudflare: { text: { cheap: { provider: "openai", model: "gpt" } } } } }, "cloudflare"), [["OPENAI_API_KEY"]]);
  assert.deepEqual(providerKeyGroups({ text: ["browser"] }, "cloudflare"), [], "a browser tier calls no backend");
  assert.deepEqual(providerKey("google", { GOOGLE_API_KEY: "g" }), "g");
});

const routedConfig: AiCapabilitiesConfig = {
  image: ["cheap", "heavy"],
  targets: {
    cloudflare: {
      image: {
        heavy: {
          secret: "AI_IMAGE_HEAVY",
          routes: {
            google: { provider: "google", model: "gemini-3.1-flash-lite-image" },
            cloudflare: { provider: "cloudflare", model: "@cf/black-forest-labs/flux-1-schnell", steps: 4 },
          },
        },
      },
    },
  },
};

// Staging and production are one release: level 3 was compiled to Gemini,
// so staging could only call Gemini or be built apart. The route is each
// deployment's setting, and an unset or undeclared one is refused rather
// than read as a default.
Deno.test("a routed tier calls the route its deployment's setting names, and no other", () => {
  assert.equal(resolveModelSpec(routedConfig, "cloudflare", "image", "heavy", { AI_IMAGE_HEAVY: "google" }).provider, "google");
  const staging = resolveModelSpec(routedConfig, "cloudflare", "image", "heavy", { AI_IMAGE_HEAVY: "cloudflare" });
  assert.deepEqual([staging.provider, staging.model, staging.steps], ["cloudflare", "@cf/black-forest-labs/flux-1-schnell", 4]);
  assert.throws(() => resolveModelSpec(routedConfig, "cloudflare", "image", "heavy", {}), /AI setting AI_IMAGE_HEAVY is not set on this deployment: it names one of google, cloudflare/);
  assert.throws(
    () => resolveModelSpec(routedConfig, "cloudflare", "image", "heavy", { AI_IMAGE_HEAVY: "sk-secret-value" }),
    (e: Error) => /is not one of google, cloudflare/.test(e.message) && !e.message.includes("sk-secret-value"),
  );
  assert.equal(resolveModelSpec(routedConfig, "local", "image", "heavy", {}).model, DEFAULT_AI_MODELS.local.image.heavy.model, "a compiled target is not routed");
});

// A Gemini key required of every deployment would put production's key on
// staging; the key of a route belongs to the deployments selecting it.
Deno.test("a routed tier's keys are its routes', and a deployment is refused only the key its route reads", () => {
  assert.deepEqual(providerKeyGroups(routedConfig, "cloudflare"), []);
  assert.deepEqual(routedSettings(routedConfig, "cloudflare"), { AI_IMAGE_HEAVY: { cloudflare: [], google: [["GEMINI_API_KEY", "GOOGLE_API_KEY"]] } });
  assert.deepEqual(routedSettings(routedConfig, "docker"), {});
  const call = (env: Record<string, string>) => resolveCallSpec(routedConfig, "cloudflare", "image", "heavy", env);
  call({ AI_IMAGE_HEAVY: "cloudflare" });
  call({ AI_IMAGE_HEAVY: "google", GEMINI_API_KEY: "k" });
  assert.throws(() => call({ AI_IMAGE_HEAVY: "google" }), /routes image heavy to google, which reads GEMINI_API_KEY or GOOGLE_API_KEY, and this deployment holds none/);
  assert.throws(() => call({}), /AI_IMAGE_HEAVY is not set/);
  const split: AiCapabilitiesConfig = {
    text: ["heavy"],
    image: ["heavy"],
    targets: { cloudflare: { text: { heavy: { secret: "AI_IMAGE_HEAVY", routes: { google: "gemini-2.5-flash" } } }, image: routedConfig.targets!.cloudflare!.image } },
  };
  assert.throws(() => routedSettings(split, "cloudflare"), /routes image heavy by cloudflare, google and another tier by google/);
});

// Vision scans send OpenAI multimodal `messages[].content` arrays (`text` + `image_url`);
// Gemini 2.5 Flash rejects `{ text: Array }` and prepends `{ thought: true }` parts when thinking runs.
Deno.test("Google provider translates multimodal image_url parts and skips thought parts", async () => {
  const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
  const gateway = createTsBifrost({
    target: "cloudflare",
    config: {
      targets: {
        cloudflare: {
          text: {
            heavy: {
              provider: "google",
              model: "gemini-2.5-flash",
              params: { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } },
            },
          },
        },
      },
    },
    env: { GEMINI_API_KEY: "gem-key" },
    fetcher: async (input, init) => {
      seen.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({
        candidates: [{
          content: {
            parts: [
              { thought: true, text: "thinking about bottle" },
              { text: '{"caption":"PET bottle"}' },
            ],
          },
        }],
      });
    },
  });

  const res = await gateway(new Request("http://tsbifrost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tier: "heavy",
      format: "json",
      messages: [
        { role: "system", content: "Return JSON." },
        {
          role: "user",
          content: [
            { type: "text", text: "Classify this specimen." },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,AQIDBA==" } },
            { type: "image_url", image_url: { url: "https://example.com/item.jpg" } },
          ],
        },
      ],
    }),
  }));
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.model, "gemini-2.5-flash");
  assert.equal(out.choices[0].message.content, '{"caption":"PET bottle"}');
  assert.equal(seen[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
  assert.deepEqual(seen[0].body.contents, [{
    role: "user",
    parts: [
      { text: "Classify this specimen." },
      { inlineData: { mimeType: "image/jpeg", data: "AQIDBA==" } },
      { fileData: { fileUri: "https://example.com/item.jpg" } },
    ],
  }]);
  assert.deepEqual(
    (seen[0].body.generationConfig as Record<string, unknown>).thinkingConfig,
    { thinkingBudget: 0 },
  );

  const thoughtOnly = createTsBifrost({
    target: "cloudflare",
    config: {
      targets: {
        cloudflare: {
          text: {
            heavy: { provider: "google", model: "gemini-2.5-flash" },
          },
        },
      },
    },
    env: { GEMINI_API_KEY: "gem-key" },
    fetcher: async () =>
      Response.json({
        candidates: [{
          content: { parts: [{ thought: true, text: "internal reasoning truncated at maxOutputTokens" }] },
        }],
      }),
  });
  const thoughtRes = await thoughtOnly(new Request("http://tsbifrost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tier: "heavy", messages: [{ role: "user", content: "Classify." }] }),
  }));
  assert.equal(thoughtRes.status, 502);
});
