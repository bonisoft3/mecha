/**
 * Intercepts HTTP requests to AI model endpoints and routes them to
 * in-browser model runtimes (WebLLM for text, ONNX SD for images).
 *
 * Used as a wrapper around the base httpHandler in browser mode.
 * Pipeline YAMLs use ${TEXT_MODEL_URL} / ${IMAGE_MODEL_URL} env vars
 * which resolve to model endpoint URLs. This handler intercepts those
 * URLs and runs inference locally instead of making network requests.
 */

export interface TextModel {
  generate(
    messages: Array<{ role: string; content: string }>,
    options?: { format?: object }
  ): Promise<string>
}

export interface ImageModel {
  generate(prompt: string): Promise<string> // returns base64 PNG
}

export interface ModelHandlerConfig {
  textModel?: TextModel
  imageModel?: ImageModel
  textModelUrl?: string // URL pattern to intercept for text
  imageModelUrl?: string // URL pattern to intercept for images
}

type HttpHandler = (req: Request) => Promise<Response>

/**
 * Wraps a base httpHandler with model interception.
 *
 * When textModel or imageModel are provided, requests matching the
 * configured URL patterns are handled locally. All other requests
 * pass through to the base handler.
 *
 * When no models are configured, this is a pure passthrough — zero overhead.
 */
export function createModelHandler(
  config: ModelHandlerConfig,
  baseHandler: HttpHandler
): HttpHandler {
  const { textModel, imageModel, textModelUrl, imageModelUrl } = config

  // If no models configured, return base handler directly — no overhead.
  if (!textModel && !imageModel) {
    return baseHandler
  }

  return async (req: Request): Promise<Response> => {
    const url = req.url

    // Text model: intercept OpenAI-compatible /v1/chat/completions
    if (textModel && textModelUrl && url.startsWith(textModelUrl)) {
      return handleTextRequest(req, textModel)
    }

    // Image model: intercept /generate endpoint
    if (imageModel && imageModelUrl && url.startsWith(imageModelUrl)) {
      return handleImageRequest(req, imageModel)
    }

    return baseHandler(req)
  }
}

async function handleTextRequest(req: Request, model: TextModel): Promise<Response> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const { messages, format } = body as {
    messages?: Array<{ role: string; content: string }>
    format?: object
  }

  if (!messages || !Array.isArray(messages)) {
    return new Response(JSON.stringify({ error: 'messages array required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const content = await model.generate(messages, format ? { format } : undefined)

  // OpenAI-compatible response
  const response = {
    choices: [
      {
        message: { role: 'assistant', content },
        finish_reason: 'stop',
        index: 0,
      },
    ],
    model: 'local',
    object: 'chat.completion',
  }

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function handleImageRequest(req: Request, model: ImageModel): Promise<Response> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const { prompt } = body as { prompt?: string }

  if (!prompt || typeof prompt !== 'string') {
    return new Response(JSON.stringify({ error: 'prompt string required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const image = await model.generate(prompt)

  return new Response(JSON.stringify({ image }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
