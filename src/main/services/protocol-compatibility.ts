/**
 * Small, dependency-free compatibility layer for the native Anthropic,
 * Gemini and Ollama wire formats.  It deliberately contains no persistence,
 * account selection or authentication: those remain in the local API server
 * so secrets never need to cross a protocol adapter boundary.
 *
 * The common internal wire is OpenAI Chat Completions.  Requests from native
 * clients are converted into Chat requests, and native upstream responses are
 * converted back to Chat before the configured public-client format is
 * emitted.  Keeping the adapters pure also makes them usable by a future
 * utility-process sidecar without moving credentials into the renderer.
 */

export type JsonObject = Record<string, unknown>

export type NativeClientProtocol =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'interactions'
  | 'ollama_chat'
  | 'ollama_generate'

export type UpstreamResponseProtocol =
  | 'responses'
  | 'chat_completions'
  | 'anthropic_messages'
  | 'gemini'
  | 'gemini_interactions'
  | 'ollama'

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON 对象`)
  }
  return value as JsonObject
}

function optionalObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function copyDefined(source: JsonObject, target: JsonObject, names: readonly string[]): void {
  for (const name of names) if (source[name] !== undefined) target[name] = source[name]
}

function dataUrl(source: JsonObject): string | null {
  const type = string(source.media_type ?? source.mimeType)
  const data = string(source.data)
  return type && data ? `data:${type};base64,${data}` : null
}

function chatContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => {
    const item = optionalObject(part)
    if (!item) return ''
    if (item.type === 'text') return string(item.text)
    return ''
  }).join('')
}

function chatChoice(bodyValue: unknown): { body: JsonObject; choice: JsonObject; message: JsonObject } {
  const body = object(bodyValue, '响应')
  const choice = object(array(body.choices)[0], '响应 choices[0]')
  return { body, choice, message: object(choice.message, '响应 choices[0].message') }
}

function chatUsageToNative(value: unknown): JsonObject {
  const usage = optionalObject(value) ?? {}
  return {
    input_tokens: number(usage.prompt_tokens) ?? 0,
    output_tokens: number(usage.completion_tokens) ?? 0
  }
}

function nativeUsageToChat(value: unknown): JsonObject | undefined {
  const usage = optionalObject(value)
  if (!usage) return undefined
  const input = number(usage.input_tokens ?? usage.promptTokenCount)
  const output = number(usage.output_tokens ?? usage.candidatesTokenCount ?? usage.eval_count)
  if (input === undefined && output === undefined) return undefined
  return {
    prompt_tokens: input ?? 0,
    completion_tokens: output ?? 0,
    total_tokens: number(usage.total_tokens ?? usage.totalTokenCount) ?? (input ?? 0) + (output ?? 0)
  }
}

function finishReasonFromAnthropic(value: unknown): string {
  switch (value) {
    case 'max_tokens': return 'length'
    case 'tool_use': return 'tool_calls'
    case 'stop_sequence':
    case 'end_turn': return 'stop'
    default: return 'stop'
  }
}

function finishReasonFromGemini(value: unknown): string {
  switch (value) {
    case 'MAX_TOKENS': return 'length'
    case 'SAFETY':
    case 'RECITATION': return 'content_filter'
    default: return 'stop'
  }
}

function anthropicStopReason(value: unknown, hasTools: boolean): string {
  if (value === 'length') return 'max_tokens'
  if (value === 'content_filter') return 'refusal'
  return hasTools ? 'tool_use' : 'end_turn'
}

function geminiFinishReason(value: unknown, hasTools: boolean): string {
  if (value === 'length') return 'MAX_TOKENS'
  if (value === 'content_filter') return 'SAFETY'
  return hasTools ? 'STOP' : 'STOP'
}

function anthropicContentToChat(contentValue: unknown, role: string, messages: JsonObject[]): void {
  const parts = typeof contentValue === 'string'
    ? [{ type: 'text', text: contentValue }]
    : array(contentValue)
  const content: JsonObject[] = []
  const toolCalls: JsonObject[] = []
  for (const partValue of parts) {
    const part = optionalObject(partValue)
    if (!part) continue
    if (part.type === 'text') {
      content.push({ type: 'text', text: string(part.text) })
    } else if (part.type === 'image') {
      const source = optionalObject(part.source)
      const url = source ? dataUrl(source) : null
      if (url) content.push({ type: 'image_url', image_url: { url } })
    } else if (part.type === 'tool_use') {
      const id = string(part.id) || `tool_${toolCalls.length}`
      toolCalls.push({
        id,
        type: 'function',
        function: { name: string(part.name), arguments: JSON.stringify(part.input ?? {}) }
      })
    } else if (part.type === 'tool_result') {
      messages.push({
        role: 'tool',
        tool_call_id: string(part.tool_use_id),
        content: chatContentText(part.content)
      })
    }
  }
  if (content.length > 0 || toolCalls.length > 0) {
    const message: JsonObject = { role: role === 'assistant' ? 'assistant' : 'user', content: content.length === 1 && content[0].type === 'text' ? content[0].text : content }
    if (toolCalls.length) message.tool_calls = toolCalls
    messages.push(message)
  }
}

/** Convert an Anthropic Messages request into an OpenAI Chat request. */
export function translateAnthropicRequestToChat(bodyValue: unknown): JsonObject {
  const body = object(bodyValue, 'Anthropic 请求')
  const model = string(body.model).trim()
  if (!model) throw new Error('Anthropic 请求必须提供 model')
  const messages: JsonObject[] = []
  const system = body.system
  if (typeof system === 'string' && system) messages.push({ role: 'developer', content: system })
  if (Array.isArray(system)) {
    const text = system.map((part) => string(optionalObject(part)?.text)).join('')
    if (text) messages.push({ role: 'developer', content: text })
  }
  for (const itemValue of array(body.messages)) {
    const item = object(itemValue, 'Anthropic messages 项')
    const role = string(item.role)
    if (role !== 'user' && role !== 'assistant') throw new Error('Anthropic 消息 role 只支持 user 或 assistant')
    anthropicContentToChat(item.content, role, messages)
  }
  const result: JsonObject = { model, messages }
  copyDefined(body, result, ['stream', 'temperature', 'top_p', 'stop_sequences', 'metadata'])
  if (body.max_tokens !== undefined) result.max_tokens = body.max_tokens
  if (body.stop_sequences !== undefined) result.stop = body.stop_sequences
  if (Array.isArray(body.tools)) {
    result.tools = body.tools.map((toolValue) => {
      const tool = object(toolValue, 'Anthropic tool')
      return {
        type: 'function',
        function: {
          name: string(tool.name),
          ...(tool.description === undefined ? {} : { description: tool.description }),
          parameters: tool.input_schema ?? {}
        }
      }
    })
  }
  const choice = optionalObject(body.tool_choice)
  if (choice) {
    if (choice.type === 'auto') result.tool_choice = 'auto'
    else if (choice.type === 'any') result.tool_choice = 'required'
    else if (choice.type === 'tool') result.tool_choice = { type: 'function', function: { name: string(choice.name) } }
  }
  return result
}

function geminiPartsToChat(partsValue: unknown, role: string, messages: JsonObject[]): void {
  const content: JsonObject[] = []
  const toolCalls: JsonObject[] = []
  for (const partValue of array(partsValue)) {
    const part = optionalObject(partValue)
    if (!part) continue
    if (typeof part.text === 'string') content.push({ type: 'text', text: part.text })
    const inline = optionalObject(part.inlineData)
    if (inline) {
      const url = dataUrl(inline)
      if (url) content.push({ type: 'image_url', image_url: { url } })
    }
    const functionCall = optionalObject(part.functionCall)
    if (functionCall) {
      const id = string(functionCall.id) || `call_${toolCalls.length}`
      toolCalls.push({
        id,
        type: 'function',
        function: { name: string(functionCall.name), arguments: JSON.stringify(functionCall.args ?? {}) }
      })
    }
    const functionResponse = optionalObject(part.functionResponse)
    if (functionResponse) {
      messages.push({
        role: 'tool',
        tool_call_id: string(functionResponse.id ?? functionResponse.name),
        content: JSON.stringify(functionResponse.response ?? {})
      })
    }
  }
  if (content.length || toolCalls.length) {
    const message: JsonObject = {
      role: role === 'model' ? 'assistant' : 'user',
      content: content.length === 1 && content[0].type === 'text' ? content[0].text : content
    }
    if (toolCalls.length) message.tool_calls = toolCalls
    messages.push(message)
  }
}

/** Convert a Gemini generateContent request into an OpenAI Chat request. */
export function translateGeminiRequestToChat(bodyValue: unknown, model: string): JsonObject {
  const body = object(bodyValue, 'Gemini 请求')
  if (!model.trim()) throw new Error('Gemini 请求路径必须提供模型')
  const messages: JsonObject[] = []
  const systemInstruction = optionalObject(body.systemInstruction)
  if (systemInstruction) {
    const text = array(systemInstruction.parts).map((part) => string(optionalObject(part)?.text)).join('')
    if (text) messages.push({ role: 'developer', content: text })
  }
  for (const itemValue of array(body.contents)) {
    const item = object(itemValue, 'Gemini contents 项')
    geminiPartsToChat(item.parts, string(item.role) || 'user', messages)
  }
  const generation = optionalObject(body.generationConfig) ?? {}
  const result: JsonObject = { model: model.trim(), messages }
  copyDefined(generation, result, ['temperature', 'topP', 'topK', 'stopSequences'])
  if (generation.topP !== undefined) result.top_p = generation.topP
  if (generation.maxOutputTokens !== undefined) result.max_tokens = generation.maxOutputTokens
  if (generation.stopSequences !== undefined) result.stop = generation.stopSequences
  if (Array.isArray(body.tools)) {
    const declarations = body.tools.flatMap((toolValue) => array(optionalObject(toolValue)?.functionDeclarations))
    if (declarations.length) result.tools = declarations.map((fnValue) => {
      const fn = object(fnValue, 'Gemini functionDeclaration')
      return { type: 'function', function: { name: string(fn.name), description: fn.description, parameters: fn.parameters ?? {} } }
    })
  }
  const toolConfig = optionalObject(body.toolConfig)
  const functionCalling = optionalObject(toolConfig?.functionCallingConfig)
  if (functionCalling?.mode === 'NONE') result.tool_choice = 'none'
  if (functionCalling?.mode === 'ANY') result.tool_choice = 'required'
  if (Array.isArray(functionCalling?.allowedFunctionNames) && functionCalling!.allowedFunctionNames!.length === 1) {
    result.tool_choice = { type: 'function', function: { name: String(functionCalling!.allowedFunctionNames![0]) } }
  }
  return result
}

function interactionInstructionText(value: unknown): string {
  if (typeof value === 'string') return value
  const instruction = optionalObject(value)
  if (!instruction) return ''
  if (typeof instruction.text === 'string') return instruction.text
  const parts = Array.isArray(instruction.parts)
    ? instruction.parts
    : Array.isArray(instruction.content) ? instruction.content : []
  return parts.map((part) => string(optionalObject(part)?.text)).join('')
}

function interactionContentToChat(
  contentValue: unknown,
  role: 'user' | 'assistant',
  messages: JsonObject[]
): void {
  if (typeof contentValue === 'string') {
    messages.push({ role, content: contentValue })
    return
  }
  const parts = Array.isArray(contentValue) ? contentValue : contentValue ? [contentValue] : []
  const content: JsonObject[] = []
  for (const partValue of parts) {
    const part = optionalObject(partValue)
    if (!part) continue
    const type = string(part.type)
    if (type === 'text' || (!type && typeof part.text === 'string')) {
      content.push({ type: 'text', text: string(part.text) })
      continue
    }
    if (type === 'image') {
      const data = string(part.data)
      const mime = string(part.mime_type ?? part.mimeType) || 'image/png'
      const imageUrl = string(part.image_url ?? part.imageUrl)
      const url = data ? `data:${mime};base64,${data}` : imageUrl
      if (url) content.push({ type: 'image_url', image_url: { url } })
    }
  }
  if (!content.length) return
  messages.push({
    role,
    content: content.length === 1 && content[0].type === 'text' ? content[0].text : content
  })
}

function interactionFunctionToChat(step: JsonObject, messages: JsonObject[]): void {
  const callId = string(step.call_id ?? step.callId ?? step.id) || `call_${messages.length}`
  const name = string(step.name)
  let argumentsValue = '{}'
  if (typeof step.arguments === 'string') argumentsValue = step.arguments
  else if (step.arguments !== undefined) argumentsValue = JSON.stringify(step.arguments)
  messages.push({
    role: 'assistant',
    content: null,
    tool_calls: [{ id: callId, type: 'function', function: { name, arguments: argumentsValue } }]
  })
}

function interactionResultToChat(step: JsonObject, messages: JsonObject[]): void {
  const callId = string(step.call_id ?? step.callId ?? step.id)
  const result = step.result ?? step.output ?? {}
  messages.push({
    role: 'tool',
    tool_call_id: callId,
    content: typeof result === 'string' ? result : JSON.stringify(result)
  })
}

/**
 * Convert Gemini's current Interactions request shape into the same internal
 * Chat wire used by the rest of the router. The format carries conversation
 * history as typed steps, so function-call and function-result steps remain
 * paired rather than being flattened into plain text.
 */
export function translateInteractionsRequestToChat(bodyValue: unknown): JsonObject {
  const body = object(bodyValue, 'Gemini Interactions 请求')
  const model = string(body.model).trim()
  if (!model) throw new Error('Gemini Interactions 请求必须提供 model')
  const messages: JsonObject[] = []
  const instruction = interactionInstructionText(body.system_instruction ?? body.systemInstruction)
  if (instruction) messages.push({ role: 'developer', content: instruction })
  const input = body.input
  const steps = typeof input === 'string' ? [input] : Array.isArray(input) ? input : input ? [input] : []
  for (const stepValue of steps) {
    if (typeof stepValue === 'string') {
      messages.push({ role: 'user', content: stepValue })
      continue
    }
    const step = object(stepValue, 'Gemini Interactions input 项')
    switch (string(step.type)) {
      case 'user_input':
        interactionContentToChat(step.content ?? step.text, 'user', messages)
        break
      case 'model_output':
        interactionContentToChat(step.content ?? step.text, 'assistant', messages)
        break
      case 'function_call':
        interactionFunctionToChat(step, messages)
        break
      case 'function_result':
        interactionResultToChat(step, messages)
        break
      case 'thought':
        if (interactionInstructionText(step.content ?? step.text)) {
          messages.push({ role: 'assistant', content: interactionInstructionText(step.content ?? step.text) })
        }
        break
      default:
        if (typeof step.content === 'string') messages.push({ role: 'user', content: step.content })
        break
    }
  }
  const generation = optionalObject(body.generation_config ?? body.generationConfig) ?? {}
  const result: JsonObject = { model, messages }
  if (body.stream === true) result.stream = true
  if (generation.temperature !== undefined) result.temperature = generation.temperature
  if (generation.top_p ?? generation.topP) result.top_p = generation.top_p ?? generation.topP
  if (generation.max_output_tokens ?? generation.maxOutputTokens) {
    result.max_tokens = generation.max_output_tokens ?? generation.maxOutputTokens
  }
  if (generation.stop_sequences ?? generation.stopSequences) {
    result.stop = generation.stop_sequences ?? generation.stopSequences
  }
  const declarations = array(body.tools).flatMap((toolValue) => {
    const tool = optionalObject(toolValue)
    if (!tool) return []
    const nested = array(tool.function_declarations ?? tool.functionDeclarations)
    return nested.length ? nested : [tool]
  })
  if (declarations.length) {
    result.tools = declarations.flatMap((value) => {
      const tool = optionalObject(value)
      const name = string(tool?.name)
      return name ? [{
        type: 'function',
        function: { name, ...(tool?.description === undefined ? {} : { description: tool.description }), parameters: tool?.parameters ?? tool?.input_schema ?? {} }
      }] : []
    })
  }
  const toolChoice = generation.tool_choice ?? body.tool_choice
  if (toolChoice !== undefined) result.tool_choice = toolChoice
  return result
}

/** Convert an Ollama chat request into an OpenAI Chat request. */
export function translateOllamaChatRequestToChat(bodyValue: unknown): JsonObject {
  const body = object(bodyValue, 'Ollama chat 请求')
  const model = string(body.model).trim()
  if (!model) throw new Error('Ollama 请求必须提供 model')
  const messages = array(body.messages).map((itemValue) => {
    const item = object(itemValue, 'Ollama message')
    const result: JsonObject = { role: string(item.role) || 'user', content: item.content ?? '' }
    if (Array.isArray(item.images)) {
      result.content = [
        ...(string(item.content) ? [{ type: 'text', text: string(item.content) }] : []),
        ...item.images.filter((image): image is string => typeof image === 'string').map((image) => ({
          type: 'image_url', image_url: { url: image.startsWith('data:') ? image : `data:image/png;base64,${image}` }
        }))
      ]
    }
    if (Array.isArray(item.tool_calls)) result.tool_calls = item.tool_calls
    return result
  })
  const options = optionalObject(body.options) ?? {}
  const result: JsonObject = { model, messages, stream: body.stream === true }
  copyDefined(options, result, ['temperature', 'top_p', 'stop', 'num_predict'])
  if (options.num_predict !== undefined) result.max_tokens = options.num_predict
  if (body.tools !== undefined) result.tools = body.tools
  return result
}

/** Convert an Ollama generate request into a single-turn Chat request. */
export function translateOllamaGenerateRequestToChat(bodyValue: unknown): JsonObject {
  const body = object(bodyValue, 'Ollama generate 请求')
  const model = string(body.model).trim()
  if (!model) throw new Error('Ollama 请求必须提供 model')
  const messages: JsonObject[] = []
  if (typeof body.system === 'string' && body.system) messages.push({ role: 'system', content: body.system })
  if (typeof body.context === 'string' && body.context) messages.push({ role: 'system', content: body.context })
  messages.push({ role: 'user', content: string(body.prompt) })
  const result: JsonObject = { model, messages, stream: body.stream === true }
  const options = optionalObject(body.options) ?? {}
  copyDefined(options, result, ['temperature', 'top_p', 'stop'])
  if (options.num_predict !== undefined) result.max_tokens = options.num_predict
  return result
}

/** Convert a Chat request into an Anthropic Messages request for a native upstream. */
export function translateChatRequestToAnthropic(bodyValue: unknown): JsonObject {
  const body = object(bodyValue, 'Chat 请求')
  const messages: JsonObject[] = []
  const systems: string[] = []
  for (const messageValue of array(body.messages)) {
    const message = object(messageValue, 'Chat message')
    const role = string(message.role)
    if (role === 'system' || role === 'developer') {
      systems.push(chatContentText(message.content))
      continue
    }
    if (role === 'tool') {
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: string(message.tool_call_id), content: chatContentText(message.content) }] })
      continue
    }
    const content: JsonObject[] = []
    if (typeof message.content === 'string') content.push({ type: 'text', text: message.content })
    else for (const partValue of array(message.content)) {
      const part = optionalObject(partValue)
      if (!part) continue
      if (part.type === 'text') content.push({ type: 'text', text: string(part.text) })
      if (part.type === 'image_url') {
        const image = optionalObject(part.image_url)
        const url = string(image?.url ?? part.image_url)
        const match = /^data:([^;]+);base64,(.+)$/i.exec(url)
        if (match) content.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } })
      }
    }
    for (const toolValue of array(message.tool_calls)) {
      const tool = optionalObject(toolValue)
      const fn = optionalObject(tool?.function)
      if (!tool || !fn) continue
      let input: unknown = {}
      try { input = JSON.parse(string(fn.arguments) || '{}') } catch { input = {} }
      content.push({ type: 'tool_use', id: string(tool.id), name: string(fn.name), input })
    }
    messages.push({ role: role === 'assistant' ? 'assistant' : 'user', content })
  }
  const result: JsonObject = {
    model: string(body.model),
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 4096,
    messages
  }
  if (systems.join('\n')) result.system = systems.join('\n')
  copyDefined(body, result, ['stream', 'temperature', 'top_p'])
  if (body.stop !== undefined) result.stop_sequences = body.stop
  if (Array.isArray(body.tools)) result.tools = body.tools.map((toolValue) => {
    const tool = object(toolValue, 'Chat tool')
    const fn = object(tool.function, 'Chat tool function')
    return { name: string(fn.name), description: fn.description, input_schema: fn.parameters ?? {} }
  })
  return result
}

/** Convert a Chat request into a Gemini generateContent request. */
export function translateChatRequestToGemini(bodyValue: unknown): JsonObject {
  const body = object(bodyValue, 'Chat 请求')
  const contents: JsonObject[] = []
  const systemParts: JsonObject[] = []
  for (const messageValue of array(body.messages)) {
    const message = object(messageValue, 'Chat message')
    const role = string(message.role)
    const parts: JsonObject[] = []
    if (typeof message.content === 'string') parts.push({ text: message.content })
    else for (const partValue of array(message.content)) {
      const part = optionalObject(partValue)
      if (!part) continue
      if (part.type === 'text') parts.push({ text: string(part.text) })
      if (part.type === 'image_url') {
        const image = optionalObject(part.image_url)
        const url = string(image?.url ?? part.image_url)
        const match = /^data:([^;]+);base64,(.+)$/i.exec(url)
        if (match) parts.push({ inlineData: { mimeType: match[1], data: match[2] } })
      }
    }
    for (const toolValue of array(message.tool_calls)) {
      const tool = optionalObject(toolValue)
      const fn = optionalObject(tool?.function)
      if (!tool || !fn) continue
      let args: unknown = {}
      try { args = JSON.parse(string(fn.arguments) || '{}') } catch { args = {} }
      parts.push({ functionCall: { id: string(tool.id), name: string(fn.name), args } })
    }
    if (role === 'tool') {
      parts.push({ functionResponse: { id: string(message.tool_call_id), name: string(message.name), response: { content: chatContentText(message.content) } } })
    }
    if (role === 'system' || role === 'developer') systemParts.push(...parts)
    else if (parts.length) contents.push({ role: role === 'assistant' ? 'model' : 'user', parts })
  }
  const generationConfig: JsonObject = {}
  if (body.temperature !== undefined) generationConfig.temperature = body.temperature
  if (body.top_p !== undefined) generationConfig.topP = body.top_p
  if (body.max_tokens ?? body.max_completion_tokens) generationConfig.maxOutputTokens = body.max_tokens ?? body.max_completion_tokens
  if (body.stop !== undefined) generationConfig.stopSequences = body.stop
  const result: JsonObject = { contents }
  if (systemParts.length) result.systemInstruction = { parts: systemParts }
  if (Object.keys(generationConfig).length) result.generationConfig = generationConfig
  if (Array.isArray(body.tools)) {
    result.tools = [{ functionDeclarations: body.tools.flatMap((toolValue) => {
      const tool = optionalObject(toolValue)
      const fn = optionalObject(tool?.function)
      return fn ? [{ name: string(fn.name), description: fn.description, parameters: fn.parameters ?? {} }] : []
    }) }]
  }
  return result
}

function chatContentToInteractionParts(contentValue: unknown): JsonObject[] {
  if (typeof contentValue === 'string') return contentValue ? [{ type: 'text', text: contentValue }] : []
  const parts: JsonObject[] = []
  for (const value of array(contentValue)) {
    const part = optionalObject(value)
    if (!part) continue
    if (part.type === 'text' || typeof part.text === 'string') {
      if (string(part.text)) parts.push({ type: 'text', text: string(part.text) })
      continue
    }
    if (part.type === 'image_url') {
      const image = optionalObject(part.image_url)
      const url = string(image?.url ?? part.image_url)
      const match = /^data:([^;]+);base64,(.+)$/i.exec(url)
      if (match) parts.push({ type: 'image', mime_type: match[1], data: match[2] })
      else if (url) parts.push({ type: 'image', image_url: url })
    }
  }
  return parts
}

/** Convert the router's Chat wire into a Gemini Interactions request. */
export function translateChatRequestToInteractions(bodyValue: unknown): JsonObject {
  const body = object(bodyValue, 'Chat 请求')
  const input: JsonObject[] = []
  const instructions: string[] = []
  for (const messageValue of array(body.messages)) {
    const message = object(messageValue, 'Chat message')
    const role = string(message.role)
    if (role === 'system' || role === 'developer') {
      const text = chatContentText(message.content)
      if (text) instructions.push(text)
      continue
    }
    if (role === 'tool') {
      const result = message.content
      input.push({
        type: 'function_result',
        call_id: string(message.tool_call_id),
        ...(message.name === undefined ? {} : { name: message.name }),
        result: typeof result === 'string' ? { content: result } : result ?? {}
      })
      continue
    }
    const parts = chatContentToInteractionParts(message.content)
    if (parts.length) input.push({ type: role === 'assistant' ? 'model_output' : 'user_input', content: parts })
    for (const toolValue of array(message.tool_calls)) {
      const tool = optionalObject(toolValue)
      const fn = optionalObject(tool?.function)
      if (!tool || !fn) continue
      let argumentsValue: unknown = {}
      try { argumentsValue = JSON.parse(string(fn.arguments) || '{}') } catch { argumentsValue = {} }
      input.push({ type: 'function_call', call_id: string(tool.id), name: string(fn.name), arguments: argumentsValue })
    }
  }
  const generationConfig: JsonObject = {}
  if (body.temperature !== undefined) generationConfig.temperature = body.temperature
  if (body.top_p !== undefined) generationConfig.top_p = body.top_p
  if (body.max_tokens ?? body.max_completion_tokens) {
    generationConfig.max_output_tokens = body.max_tokens ?? body.max_completion_tokens
  }
  if (body.stop !== undefined) generationConfig.stop_sequences = body.stop
  const result: JsonObject = { model: string(body.model), input, stream: body.stream === true }
  if (instructions.length) result.system_instruction = { parts: instructions.map((text) => ({ text })) }
  if (Object.keys(generationConfig).length) result.generation_config = generationConfig
  if (Array.isArray(body.tools)) {
    const functionDeclarations = body.tools.flatMap((toolValue) => {
      const tool = optionalObject(toolValue)
      const fn = optionalObject(tool?.function)
      return fn ? [{ name: string(fn.name), ...(fn.description === undefined ? {} : { description: fn.description }), parameters: fn.parameters ?? {} }] : []
    })
    if (functionDeclarations.length) result.tools = [{ function_declarations: functionDeclarations }]
  }
  if (body.tool_choice !== undefined) result.generation_config = { ...generationConfig, tool_choice: body.tool_choice }
  return result
}

/** Convert a Chat request into an Ollama /api/chat request. */
export function translateChatRequestToOllama(bodyValue: unknown): JsonObject {
  const body = object(bodyValue, 'Chat 请求')
  const messages = array(body.messages).map((messageValue) => {
    const message = object(messageValue, 'Chat message')
    const result: JsonObject = { role: string(message.role), content: chatContentText(message.content) }
    const images: string[] = []
    for (const partValue of array(message.content)) {
      const part = optionalObject(partValue)
      const image = optionalObject(part?.image_url)
      const url = string(image?.url ?? part?.image_url)
      const match = /^data:[^;]+;base64,(.+)$/i.exec(url)
      if (match) images.push(match[1])
    }
    if (images.length) result.images = images
    if (Array.isArray(message.tool_calls)) result.tool_calls = message.tool_calls
    return result
  })
  const options: JsonObject = {}
  copyDefined(body, options, ['temperature', 'top_p', 'stop'])
  if (body.max_tokens ?? body.max_completion_tokens) options.num_predict = body.max_tokens ?? body.max_completion_tokens
  return { model: string(body.model), messages, stream: body.stream === true, ...(Object.keys(options).length ? { options } : {}), ...(body.tools === undefined ? {} : { tools: body.tools }) }
}

/** Convert a successful Anthropic Messages response into Chat Completions. */
export function translateAnthropicResponseToChat(bodyValue: unknown): JsonObject {
  const body = object(bodyValue, 'Anthropic 响应')
  const content = array(body.content)
  let text = ''
  const toolCalls: JsonObject[] = []
  for (const itemValue of content) {
    const item = optionalObject(itemValue)
    if (!item) continue
    if (item.type === 'text') text += string(item.text)
    if (item.type === 'tool_use') toolCalls.push({
      id: string(item.id), type: 'function',
      function: { name: string(item.name), arguments: JSON.stringify(item.input ?? {}) }
    })
  }
  const message: JsonObject = { role: 'assistant', content: text || null }
  if (toolCalls.length) message.tool_calls = toolCalls
  const result: JsonObject = {
    id: string(body.id) || 'chatcmpl_anthropic', object: 'chat.completion',
    created: Math.floor(Date.now() / 1000), model: string(body.model),
    choices: [{ index: 0, message, logprobs: null, finish_reason: finishReasonFromAnthropic(body.stop_reason) }]
  }
  const usage = nativeUsageToChat(body.usage)
  if (usage) result.usage = usage
  return result
}

/** Convert a successful Gemini generateContent response into Chat Completions. */
export function translateGeminiResponseToChat(bodyValue: unknown): JsonObject {
  const body = object(bodyValue, 'Gemini 响应')
  const candidate = optionalObject(array(body.candidates)[0]) ?? {}
  const content = optionalObject(candidate.content) ?? {}
  let text = ''
  const toolCalls: JsonObject[] = []
  for (const partValue of array(content.parts)) {
    const part = optionalObject(partValue)
    if (!part) continue
    if (typeof part.text === 'string') text += part.text
    const functionCall = optionalObject(part.functionCall)
    if (functionCall) toolCalls.push({
      id: string(functionCall.id) || `call_${toolCalls.length}`,
      type: 'function', function: { name: string(functionCall.name), arguments: JSON.stringify(functionCall.args ?? {}) }
    })
  }
  const message: JsonObject = { role: 'assistant', content: text || null }
  if (toolCalls.length) message.tool_calls = toolCalls
  const result: JsonObject = {
    id: string(body.responseId) || 'chatcmpl_gemini', object: 'chat.completion',
    created: Math.floor(Date.now() / 1000), model: string(body.modelVersion),
    choices: [{ index: 0, message, logprobs: null, finish_reason: finishReasonFromGemini(candidate.finishReason) }]
  }
  const usage = nativeUsageToChat(body.usageMetadata)
  if (usage) result.usage = usage
  return result
}

/** Convert a completed Gemini Interactions response into Chat Completions. */
export function translateInteractionsResponseToChat(bodyValue: unknown): JsonObject {
  const envelope = object(bodyValue, 'Gemini Interactions 响应')
  const body = optionalObject(envelope.interaction) ?? envelope
  let text = ''
  const toolCalls: JsonObject[] = []
  for (const value of array(body.steps)) {
    const step = optionalObject(value)
    if (!step) continue
    if (step.type === 'model_output') {
      const content = step.content
      if (typeof content === 'string') text += content
      for (const partValue of array(content)) {
        const part = optionalObject(partValue)
        if (part?.type === 'text' || typeof part?.text === 'string') text += string(part?.text)
      }
    }
    if (step.type === 'function_call') {
      const id = string(step.call_id ?? step.callId ?? step.id) || `call_${toolCalls.length}`
      toolCalls.push({
        id,
        type: 'function',
        function: {
          name: string(step.name),
          arguments: typeof step.arguments === 'string' ? step.arguments : JSON.stringify(step.arguments ?? {})
        }
      })
    }
  }
  const usage = optionalObject(body.usage ?? envelope.usage) ?? {}
  const prompt = number(usage.total_input_tokens ?? usage.totalInputTokens) ?? 0
  const completion = number(usage.total_output_tokens ?? usage.totalOutputTokens) ?? 0
  const total = number(usage.total_tokens ?? usage.totalTokens) ?? prompt + completion
  const message: JsonObject = { role: 'assistant', content: text || null }
  if (toolCalls.length) message.tool_calls = toolCalls
  return {
    id: string(body.id) || 'chatcmpl_interactions',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: string(body.model),
    choices: [{
      index: 0,
      message,
      logprobs: null,
      finish_reason: toolCalls.length || body.status === 'requires_action' ? 'tool_calls' : 'stop'
    }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total }
  }
}

/** Convert a successful Ollama /api/chat response into Chat Completions. */
export function translateOllamaResponseToChat(bodyValue: unknown): JsonObject {
  const body = object(bodyValue, 'Ollama 响应')
  const message = optionalObject(body.message) ?? { role: 'assistant', content: body.response ?? '' }
  const result: JsonObject = {
    id: string(body.id) || 'chatcmpl_ollama', object: 'chat.completion',
    created: Math.floor(Date.now() / 1000), model: string(body.model),
    choices: [{ index: 0, message: { role: string(message.role) || 'assistant', content: message.content ?? '', ...(Array.isArray(message.tool_calls) ? { tool_calls: message.tool_calls } : {}) }, logprobs: null, finish_reason: body.done_reason === 'length' ? 'length' : 'stop' }]
  }
  const usage = nativeUsageToChat({ prompt_tokens: body.prompt_eval_count, completion_tokens: body.eval_count, total_tokens: (number(body.prompt_eval_count) ?? 0) + (number(body.eval_count) ?? 0) })
  if (usage) result.usage = usage
  return result
}

/** Convert a Chat Completions response for a native caller. */
export function translateChatResponseForClient(
  bodyValue: unknown,
  protocol: Exclude<NativeClientProtocol, 'openai'>
): JsonObject {
  const { body, choice, message } = chatChoice(bodyValue)
  const text = chatContentText(message.content)
  const toolCalls = array(message.tool_calls).flatMap((itemValue) => {
    const item = optionalObject(itemValue)
    const fn = optionalObject(item?.function)
    if (!item || !fn) return []
    let input: unknown = {}
    try { input = JSON.parse(string(fn.arguments) || '{}') } catch { input = {} }
    return [{ id: string(item.id), name: string(fn.name), input }]
  })
  if (protocol === 'interactions') {
    const steps: JsonObject[] = []
    if (text) steps.push({ type: 'model_output', content: [{ type: 'text', text }] })
    steps.push(...toolCalls.map((tool) => ({
      type: 'function_call', call_id: tool.id, name: tool.name, arguments: tool.input
    })))
    const usage = optionalObject(body.usage) ?? {}
    return {
      id: string(body.id) || 'interaction_local',
      object: 'interaction',
      model: string(body.model),
      status: toolCalls.length ? 'requires_action' : 'completed',
      steps,
      usage: {
        total_input_tokens: number(usage.prompt_tokens) ?? 0,
        total_output_tokens: number(usage.completion_tokens) ?? 0,
        total_tokens: number(usage.total_tokens) ?? 0
      }
    }
  }
  if (protocol === 'anthropic') {
    const content: JsonObject[] = []
    if (text) content.push({ type: 'text', text })
    content.push(...toolCalls.map((tool) => ({ type: 'tool_use', ...tool })))
    return {
      id: string(body.id) || 'msg_local', type: 'message', role: 'assistant',
      model: string(body.model), content,
      stop_reason: anthropicStopReason(choice.finish_reason, toolCalls.length > 0),
      stop_sequence: null, usage: chatUsageToNative(body.usage)
    }
  }
  if (protocol === 'gemini') {
    const parts: JsonObject[] = []
    if (text) parts.push({ text })
    parts.push(...toolCalls.map((tool) => ({ functionCall: { id: tool.id, name: tool.name, args: tool.input } })))
    const usage = optionalObject(body.usage) ?? {}
    return {
      candidates: [{ content: { role: 'model', parts }, finishReason: geminiFinishReason(choice.finish_reason, toolCalls.length > 0), index: 0 }],
      usageMetadata: {
        promptTokenCount: number(usage.prompt_tokens) ?? 0,
        candidatesTokenCount: number(usage.completion_tokens) ?? 0,
        totalTokenCount: number(usage.total_tokens) ?? 0
      }, modelVersion: string(body.model)
    }
  }
  const base: JsonObject = {
    model: string(body.model), created_at: new Date().toISOString(), done: true,
    done_reason: choice.finish_reason === 'length' ? 'length' : 'stop',
    prompt_eval_count: number(optionalObject(body.usage)?.prompt_tokens) ?? 0,
    eval_count: number(optionalObject(body.usage)?.completion_tokens) ?? 0
  }
  if (protocol === 'ollama_chat') return { ...base, message: { role: 'assistant', content: text, ...(toolCalls.length ? { tool_calls: toolCalls.map((tool) => ({ id: tool.id, function: { name: tool.name, arguments: tool.input } })) } : {}) } }
  return { ...base, response: text }
}

interface SseEvent { event?: string; data: string }

class SseDecoder {
  private readonly decoder = new TextDecoder()
  private buffer = ''

  push(chunk: Uint8Array): SseEvent[] {
    this.buffer += this.decoder.decode(chunk, { stream: true })
    return this.drain(false)
  }

  finish(): SseEvent[] {
    this.buffer += this.decoder.decode()
    return this.drain(true)
  }

  private drain(flush: boolean): SseEvent[] {
    const events: SseEvent[] = []
    while (true) {
      const separator = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer)
      if (!separator) break
      const block = this.buffer.slice(0, separator.index)
      this.buffer = this.buffer.slice(separator.index + separator[0].length)
      const event = this.block(block)
      if (event) events.push(event)
    }
    if (flush && this.buffer.trim()) {
      const event = this.block(this.buffer)
      this.buffer = ''
      if (event) events.push(event)
    }
    return events
  }

  private block(block: string): SseEvent | null {
    const data: string[] = []
    let event: string | undefined
    for (const line of block.split(/\r\n|\n|\r/)) {
      if (!line || line.startsWith(':')) continue
      const pivot = line.indexOf(':')
      const name = pivot < 0 ? line : line.slice(0, pivot)
      const value = pivot < 0 ? '' : line.slice(pivot + 1).replace(/^ /, '')
      if (name === 'event') event = value
      if (name === 'data') data.push(value)
    }
    return data.length ? { event, data: data.join('\n') } : null
  }
}

function event(type: string, payload: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
}

function chatChunk(id: string, model: string, delta: JsonObject, finishReason: unknown = null): string {
  return `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }] })}\n\n`
}

function transformBytes(
  transform: (event: SseEvent) => string[],
  flush: () => string[] = () => []
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new SseDecoder()
  const encoder = new TextEncoder()
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      for (const item of decoder.push(chunk)) for (const output of transform(item)) controller.enqueue(encoder.encode(output))
    },
    flush(controller) {
      for (const item of decoder.finish()) for (const output of transform(item)) controller.enqueue(encoder.encode(output))
      for (const output of flush()) controller.enqueue(encoder.encode(output))
    }
  })
}

/** Convert a native Anthropic event stream to OpenAI Chat SSE. */
export function translateAnthropicSseToChat(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let id = 'chatcmpl_anthropic'
  let model = ''
  let started = false
  let finish = 'stop'
  let outputTokens = 0
  const toolIndexes = new Map<number, { id: string; name: string }>()
  return source.pipeThrough(transformBytes((item) => {
    let payload: JsonObject
    try { payload = object(JSON.parse(item.data), 'Anthropic stream') } catch { return [] }
    const type = string(payload.type || item.event)
    const out: string[] = []
    if (type === 'message_start') {
      const message = optionalObject(payload.message) ?? {}
      id = string(message.id) || id; model = string(message.model) || model
      if (!started) { started = true; out.push(chatChunk(id, model, { role: 'assistant', content: '' })) }
    } else if (type === 'content_block_start') {
      const index = number(payload.index) ?? 0
      const block = optionalObject(payload.content_block) ?? {}
      if (block.type === 'tool_use') {
        const tool = { id: string(block.id), name: string(block.name) }
        toolIndexes.set(index, tool)
        out.push(chatChunk(id, model, { tool_calls: [{ index, id: tool.id, type: 'function', function: { name: tool.name, arguments: '' } }] }))
      }
    } else if (type === 'content_block_delta') {
      const index = number(payload.index) ?? 0
      const delta = optionalObject(payload.delta) ?? {}
      if (delta.type === 'text_delta' && typeof delta.text === 'string') out.push(chatChunk(id, model, { content: delta.text }))
      if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') out.push(chatChunk(id, model, { tool_calls: [{ index, function: { arguments: delta.partial_json } }] }))
    } else if (type === 'message_delta') {
      const delta = optionalObject(payload.delta) ?? {}
      finish = finishReasonFromAnthropic(delta.stop_reason)
      outputTokens = number(optionalObject(payload.usage)?.output_tokens) ?? outputTokens
    } else if (type === 'error') {
      out.push(`data: ${JSON.stringify({ error: payload.error ?? payload })}\n\n`, 'data: [DONE]\n\n')
    } else if (type === 'message_stop') {
      out.push(chatChunk(id, model, {}, finish), `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [], usage: { prompt_tokens: 0, completion_tokens: outputTokens, total_tokens: outputTokens } })}\n\n`, 'data: [DONE]\n\n')
    }
    return out
  }))
}

/** Convert a Gemini stream (SSE chunks) to OpenAI Chat SSE. */
export function translateGeminiSseToChat(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let id = 'chatcmpl_gemini'
  let model = ''
  let started = false
  let emitted = ''
  return source.pipeThrough(transformBytes((item) => {
    let payload: JsonObject
    try { payload = object(JSON.parse(item.data), 'Gemini stream') } catch { return [] }
    const candidate = optionalObject(array(payload.candidates)[0]) ?? {}
    const content = optionalObject(candidate.content) ?? {}
    const fullText = array(content.parts).map((part) => string(optionalObject(part)?.text)).join('')
    model = string(payload.modelVersion) || model
    const out: string[] = []
    if (!started) { started = true; out.push(chatChunk(id, model, { role: 'assistant', content: '' })) }
    // Gemini-compatible gateways differ here: some send the complete text so
    // far, while others send only the next delta. Handle both without
    // duplicating the cumulative variant or dropping the delta variant.
    const delta = fullText.startsWith(emitted)
      ? fullText.slice(emitted.length)
      : emitted.startsWith(fullText) ? '' : fullText
    if (delta) {
      out.push(chatChunk(id, model, { content: delta }))
      emitted = fullText.startsWith(emitted) ? fullText : `${emitted}${fullText}`
    }
    if (candidate.finishReason) out.push(chatChunk(id, model, {}, finishReasonFromGemini(candidate.finishReason)), 'data: [DONE]\n\n')
    return out
  }, () => started ? [] : [chatChunk(id, model, { role: 'assistant', content: '' }), chatChunk(id, model, {}, 'stop'), 'data: [DONE]\n\n']))
}

/**
 * Convert Gemini v1beta Interactions SSE to OpenAI Chat SSE. Interactions
 * puts its event name in the JSON payload (`event_type`) in addition to the
 * SSE `event` field, and compatible gateways are inconsistent about which
 * one they send. Accept both forms so a proxy does not drop otherwise valid
 * text or function-call deltas.
 */
export function translateInteractionsSseToChat(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let id = 'chatcmpl_interactions'
  let model = ''
  let started = false
  let finished = false
  const toolIndexes = new Map<number, { id: string; name: string }>()
  const start = (out: string[]): void => {
    if (!started) {
      started = true
      out.push(chatChunk(id, model, { role: 'assistant', content: '' }))
    }
  }
  const finish = (out: string[], status: unknown): void => {
    if (finished) return
    finished = true
    out.push(chatChunk(id, model, {}, status === 'requires_action' ? 'tool_calls' : 'stop'), 'data: [DONE]\n\n')
  }
  return source.pipeThrough(transformBytes((item) => {
    if (item.data === '[DONE]') {
      const out: string[] = []
      start(out)
      finish(out, 'completed')
      return out
    }
    let payload: JsonObject
    try { payload = object(JSON.parse(item.data), 'Gemini Interactions stream') } catch { return [] }
    const interaction = optionalObject(payload.interaction) ?? {}
    id = string(interaction.id ?? payload.id) || id
    model = string(interaction.model ?? payload.model) || model
    const type = string(payload.event_type ?? payload.type ?? item.event)
    const out: string[] = []
    if (type === 'interaction.created') {
      start(out)
      return out
    }
    if (type === 'step.start') {
      const index = number(payload.index) ?? 0
      const step = optionalObject(payload.step) ?? {}
      const stepType = string(step.type)
      if (stepType === 'model_output') {
        start(out)
      } else if (stepType === 'function_call') {
        start(out)
        const tool = {
          id: string(step.call_id ?? step.callId ?? step.id) || `call_${index}`,
          name: string(step.name)
        }
        toolIndexes.set(index, tool)
        const argumentsValue = typeof step.arguments === 'string' ? step.arguments : step.arguments === undefined ? '' : JSON.stringify(step.arguments)
        out.push(chatChunk(id, model, {
          tool_calls: [{ index, id: tool.id, type: 'function', function: { name: tool.name, arguments: argumentsValue } }]
        }))
      }
      return out
    }
    if (type === 'step.delta') {
      const index = number(payload.index) ?? 0
      const delta = optionalObject(payload.delta) ?? {}
      const deltaType = string(delta.type)
      if (deltaType === 'arguments_delta') {
        const tool = toolIndexes.get(index) ?? { id: `call_${index}`, name: '' }
        toolIndexes.set(index, tool)
        const argumentsDelta = string(delta.arguments ?? delta.text)
        if (argumentsDelta) {
          start(out)
          out.push(chatChunk(id, model, { tool_calls: [{ index, function: { arguments: argumentsDelta } }] }))
        }
      } else {
        const text = string(delta.text ?? optionalObject(delta.content)?.text)
        if (text) {
          start(out)
          out.push(chatChunk(id, model, { content: text }))
        }
      }
      return out
    }
    if (type === 'interaction.completed' || type === 'finish') {
      start(out)
      finish(out, interaction.status ?? payload.status)
      return out
    }
    if (type === 'done') {
      start(out)
      finish(out, 'completed')
    }
    return out
  }, () => {
    if (finished) return []
    const out: string[] = []
    start(out)
    finish(out, 'completed')
    return out
  }))
}

/** Convert Ollama's line-delimited stream to OpenAI Chat SSE. */
export function translateOllamaStreamToChat(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  let id = 'chatcmpl_ollama'
  let model = ''
  let started = false
  const process = (line: string): string[] => {
    let payload: JsonObject
    try { payload = object(JSON.parse(line), 'Ollama stream') } catch { return [] }
    model = string(payload.model) || model
    const out: string[] = []
    if (!started) { started = true; out.push(chatChunk(id, model, { role: 'assistant', content: '' })) }
    const message = optionalObject(payload.message)
    const content = string(message?.content ?? payload.response)
    if (content) out.push(chatChunk(id, model, { content }))
    if (payload.done === true) out.push(chatChunk(id, model, {}, payload.done_reason === 'length' ? 'length' : 'stop'), 'data: [DONE]\n\n')
    return out
  }
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let newline: number
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1)
            for (const output of process(line)) controller.enqueue(encoder.encode(output))
          }
        }
        buffer += decoder.decode()
        if (buffer.trim()) for (const output of process(buffer.trim())) controller.enqueue(encoder.encode(output))
      } finally { reader.releaseLock(); controller.close() }
    }
  })
}

/** Convert an OpenAI Chat SSE stream to the selected native client stream. */
export function translateChatSseForClient(
  source: ReadableStream<Uint8Array>,
  protocol: Exclude<NativeClientProtocol, 'openai'>
): ReadableStream<Uint8Array> {
  let id = protocol === 'anthropic' ? 'msg_local' : 'local'
  let model = ''
  let started = false
  let textStarted = false
  let text = ''
  let finished = false
  const toolIndexes = new Map<number, { id: string; name: string }>()
  const anthro = (item: SseEvent): string[] => {
    if (item.data === '[DONE]') return []
    let payload: JsonObject
    try { payload = object(JSON.parse(item.data), 'Chat stream') } catch { return [] }
    if (optionalObject(payload.error)) return [event('error', { type: 'error', error: payload.error })]
    id = string(payload.id) || id; model = string(payload.model) || model
    const choice = optionalObject(array(payload.choices)[0])
    const delta = optionalObject(choice?.delta) ?? {}
    const out: string[] = []
    if (!started) {
      started = true
      out.push(event('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }))
    }
    if (typeof delta.content === 'string' && delta.content) {
      if (!textStarted) { textStarted = true; out.push(event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })) }
      text += delta.content
      out.push(event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta.content } }))
    }
    if (choice?.finish_reason !== null && choice?.finish_reason !== undefined && !finished) {
      finished = true
      if (textStarted) out.push(event('content_block_stop', { type: 'content_block_stop', index: 0 }))
      out.push(event('message_delta', { type: 'message_delta', delta: { stop_reason: anthropicStopReason(choice.finish_reason, false), stop_sequence: null }, usage: { output_tokens: 0 } }), event('message_stop', { type: 'message_stop' }))
    }
    return out
  }
  const native = (item: SseEvent): string[] => {
    if (item.data === '[DONE]') return []
    let payload: JsonObject
    try { payload = object(JSON.parse(item.data), 'Chat stream') } catch { return [] }
    id = string(payload.id) || id; model = string(payload.model) || model
    const choice = optionalObject(array(payload.choices)[0])
    const delta = optionalObject(choice?.delta) ?? {}
    const content = string(delta.content)
    const done = choice?.finish_reason !== null && choice?.finish_reason !== undefined
    if (protocol === 'gemini') {
      if (!content && !done) return []
      const payloadOut: JsonObject = { candidates: [{ content: { role: 'model', parts: content ? [{ text: content }] : [] }, index: 0, ...(done ? { finishReason: geminiFinishReason(choice!.finish_reason, false) } : {}) }], modelVersion: model }
      return [`data: ${JSON.stringify(payloadOut)}\n\n`]
    }
    const base: JsonObject = { model, created_at: new Date().toISOString(), done, ...(done ? { done_reason: choice!.finish_reason === 'length' ? 'length' : 'stop' } : {}) }
    const value = protocol === 'ollama_chat'
      ? { ...base, message: { role: 'assistant', content } }
      : { ...base, response: content }
    return [`${JSON.stringify(value)}\n`]
  }
  const interactions = (item: SseEvent): string[] => {
    if (item.data === '[DONE]') return []
    let payload: JsonObject
    try { payload = object(JSON.parse(item.data), 'Chat stream') } catch { return [] }
    if (optionalObject(payload.error)) return [event('error', { event_type: 'error', error: payload.error })]
    id = string(payload.id) || id; model = string(payload.model) || model
    const choice = optionalObject(array(payload.choices)[0])
    const delta = optionalObject(choice?.delta) ?? {}
    const out: string[] = []
    if (!started) {
      started = true
      out.push(event('interaction.created', {
        event_type: 'interaction.created',
        interaction: { id, object: 'interaction', model, status: 'in_progress', steps: [] }
      }))
    }
    if (typeof delta.content === 'string' && delta.content) {
      if (!textStarted) {
        textStarted = true
        out.push(event('step.start', {
          event_type: 'step.start', index: 0,
          step: { id: `${id}_output_0`, type: 'model_output', content: [] }
        }))
      }
      text += delta.content
      out.push(event('step.delta', {
        event_type: 'step.delta', index: 0,
        delta: { type: 'text_delta', text: delta.content }
      }))
    }
    for (const toolValue of array(delta.tool_calls)) {
      const toolDelta = optionalObject(toolValue)
      if (!toolDelta) continue
      const index = number(toolDelta.index) ?? 0
      const fn = optionalObject(toolDelta.function) ?? {}
      const known = toolIndexes.get(index)
      const idValue = string(toolDelta.id) || known?.id || `call_${index}`
      const name = string(fn.name) || known?.name || ''
      if (!known) {
        toolIndexes.set(index, { id: idValue, name })
        out.push(event('step.start', {
          event_type: 'step.start', index: index + 1,
          step: { id: idValue, type: 'function_call', call_id: idValue, name, arguments: {} }
        }))
      }
      const argumentsDelta = string(fn.arguments)
      if (argumentsDelta) {
        out.push(event('step.delta', {
          event_type: 'step.delta', index: index + 1,
          delta: { type: 'arguments_delta', arguments: argumentsDelta }
        }))
      }
    }
    if (choice?.finish_reason !== null && choice?.finish_reason !== undefined && !finished) {
      finished = true
      if (textStarted) out.push(event('step.stop', { event_type: 'step.stop', index: 0 }))
      for (const index of toolIndexes.keys()) {
        out.push(event('step.stop', { event_type: 'step.stop', index: index + 1 }))
      }
      out.push(
        event('interaction.completed', {
          event_type: 'interaction.completed',
          interaction: { id, object: 'interaction', model, status: toolIndexes.size ? 'requires_action' : 'completed' }
        }),
        event('done', { event_type: 'done' })
      )
    }
    return out
  }
  if (protocol === 'interactions') {
    return source.pipeThrough(transformBytes(interactions, () => {
      if (!started) return []
      if (finished) return []
      const out: string[] = []
      if (textStarted) out.push(event('step.stop', { event_type: 'step.stop', index: 0 }))
      for (const index of toolIndexes.keys()) out.push(event('step.stop', { event_type: 'step.stop', index: index + 1 }))
      out.push(
        event('interaction.completed', {
          event_type: 'interaction.completed',
          interaction: { id, object: 'interaction', model, status: toolIndexes.size ? 'requires_action' : 'completed' }
        }),
        event('done', { event_type: 'done' })
      )
      return out
    }))
  }
  return source.pipeThrough(transformBytes(protocol === 'anthropic' ? anthro : native, () => {
    if (protocol === 'anthropic' && started && !finished) {
      return [...(textStarted ? [event('content_block_stop', { type: 'content_block_stop', index: 0 })] : []), event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } }), event('message_stop', { type: 'message_stop' })]
    }
    return []
  }))
}

export function clientResponseContentType(protocol: NativeClientProtocol): string {
  if (protocol === 'openai' || protocol === 'anthropic' || protocol === 'gemini' || protocol === 'interactions') return 'text/event-stream; charset=utf-8'
  return 'application/x-ndjson; charset=utf-8'
}
