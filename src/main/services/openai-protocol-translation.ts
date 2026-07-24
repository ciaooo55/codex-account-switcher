/**
 * Loss-aware translations between the OpenAI Chat Completions and Responses
 * wire formats. This module is deliberately stateless with respect to
 * authentication: callers remain responsible for headers and must never pass
 * secrets into these helpers.
 */

export type OpenAiProtocolTranslationDirection =
  | 'chat_to_responses'
  | 'responses_to_chat'

export interface OpenAiSseTranslationOptions {
  /** Used only when an upstream event omits its model. */
  model?: string
  /** Used only when an upstream event omits its response id. */
  responseId?: string
  /** Unix time in seconds. */
  created?: number
  /** Emit the standard final Chat Completions usage-only chunk. Default true. */
  includeUsage?: boolean
}

export class OpenAiProtocolTranslationError extends Error {
  readonly code = 'unsupported_protocol_shape'

  constructor(message: string, readonly path?: string) {
    super(path ? `${message} (${path})` : message)
    this.name = 'OpenAiProtocolTranslationError'
  }
}

type JsonObject = Record<string, unknown>

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function objectAt(value: unknown, path: string): JsonObject {
  if (!isObject(value)) throw new OpenAiProtocolTranslationError('必须是 JSON 对象', path)
  return value
}

function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new OpenAiProtocolTranslationError('必须是数组', path)
  return value
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new OpenAiProtocolTranslationError('必须是字符串', path)
  return value
}

function copyDefined(source: JsonObject, target: JsonObject, keys: readonly string[]): void {
  for (const key of keys) {
    if (source[key] !== undefined) target[key] = source[key]
  }
}

function chatPartToResponses(partValue: unknown, role: string, path: string): JsonObject {
  const part = objectAt(partValue, path)
  if (part.type === 'text') {
    return { type: 'input_text', text: stringAt(part.text, `${path}.text`) }
  }
  if (part.type === 'image_url') {
    if (role !== 'user') {
      throw new OpenAiProtocolTranslationError('只有 user 消息中的图片可安全转换', path)
    }
    const image = typeof part.image_url === 'string'
      ? { url: part.image_url }
      : objectAt(part.image_url, `${path}.image_url`)
    const converted: JsonObject = {
      type: 'input_image',
      image_url: stringAt(image.url, `${path}.image_url.url`)
    }
    if (image.detail !== undefined) converted.detail = image.detail
    return converted
  }
  throw new OpenAiProtocolTranslationError(`不支持的 Chat 内容类型“${String(part.type)}”`, path)
}

function chatContentToResponses(content: unknown, role: string, path: string): unknown {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  return arrayAt(content, path).map((part, index) =>
    chatPartToResponses(part, role, `${path}[${index}]`)
  )
}

function responsesPartToChat(partValue: unknown, role: string, path: string): JsonObject {
  const part = objectAt(partValue, path)
  if (part.type === 'input_text' || part.type === 'output_text') {
    return { type: 'text', text: stringAt(part.text, `${path}.text`) }
  }
  if (part.type === 'input_image') {
    if (role !== 'user') {
      throw new OpenAiProtocolTranslationError('只有 user 消息中的图片可安全转换', path)
    }
    const imageUrl = part.image_url ?? part.image_data
    const image: JsonObject = { url: stringAt(imageUrl, `${path}.image_url`) }
    if (part.detail !== undefined) image.detail = part.detail
    return { type: 'image_url', image_url: image }
  }
  throw new OpenAiProtocolTranslationError(`不支持的 Responses 内容类型“${String(part.type)}”`, path)
}

function responsesContentToChat(content: unknown, role: string, path: string): unknown {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  const parts = arrayAt(content, path).map((part, index) =>
    responsesPartToChat(part, role, `${path}[${index}]`)
  )
  if (parts.every((part) => part.type === 'text')) {
    return parts.map((part) => String(part.text)).join('')
  }
  return parts
}

function chatToolsToResponses(value: unknown): JsonObject[] {
  return arrayAt(value, 'tools').map((toolValue, index) => {
    const tool = objectAt(toolValue, `tools[${index}]`)
    if (tool.type !== 'function') {
      throw new OpenAiProtocolTranslationError('仅支持 function 工具', `tools[${index}]`)
    }
    const fn = objectAt(tool.function, `tools[${index}].function`)
    const result: JsonObject = {
      type: 'function',
      name: stringAt(fn.name, `tools[${index}].function.name`),
      parameters: fn.parameters ?? {}
    }
    copyDefined(fn, result, ['description', 'strict'])
    return result
  })
}

function responsesToolsToChat(value: unknown): JsonObject[] {
  return arrayAt(value, 'tools').map((toolValue, index) => {
    const tool = objectAt(toolValue, `tools[${index}]`)
    if (tool.type !== 'function') {
      throw new OpenAiProtocolTranslationError('仅支持 function 工具', `tools[${index}]`)
    }
    const fn: JsonObject = {
      name: stringAt(tool.name, `tools[${index}].name`),
      parameters: tool.parameters ?? {}
    }
    copyDefined(tool, fn, ['description', 'strict'])
    return { type: 'function', function: fn }
  })
}

function chatToolChoiceToResponses(value: unknown): unknown {
  if (typeof value === 'string') return value
  const choice = objectAt(value, 'tool_choice')
  if (choice.type !== 'function') return choice
  const fn = objectAt(choice.function, 'tool_choice.function')
  return { type: 'function', name: stringAt(fn.name, 'tool_choice.function.name') }
}

function responsesToolChoiceToChat(value: unknown): unknown {
  if (typeof value === 'string') return value
  const choice = objectAt(value, 'tool_choice')
  if (choice.type !== 'function') return choice
  return {
    type: 'function',
    function: { name: stringAt(choice.name, 'tool_choice.name') }
  }
}

function chatResponseFormatToResponses(value: unknown): JsonObject {
  const format = objectAt(value, 'response_format')
  if (format.type !== 'json_schema') return { ...format }
  const schema = objectAt(format.json_schema, 'response_format.json_schema')
  return { type: 'json_schema', ...schema }
}

function responsesTextToChatFormat(value: unknown): JsonObject | undefined {
  const text = objectAt(value, 'text')
  if (text.format === undefined) return undefined
  const format = objectAt(text.format, 'text.format')
  if (format.type !== 'json_schema') return { ...format }
  const { type: _type, ...jsonSchema } = format
  return { type: 'json_schema', json_schema: jsonSchema }
}

/** Convert a Chat Completions request body into a Responses request body. */
export function translateChatCompletionsRequestToResponses(bodyValue: unknown): JsonObject {
  const body = objectAt(bodyValue, 'request')
  const messages = arrayAt(body.messages, 'messages')
  const input: JsonObject[] = []

  messages.forEach((messageValue, index) => {
    const path = `messages[${index}]`
    const message = objectAt(messageValue, path)
    const role = stringAt(message.role, `${path}.role`)

    if (role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: stringAt(message.tool_call_id, `${path}.tool_call_id`),
        output: typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content ?? '')
      })
      return
    }
    if (!['system', 'developer', 'user', 'assistant'].includes(role)) {
      throw new OpenAiProtocolTranslationError(`不支持的消息角色“${role}”`, `${path}.role`)
    }

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
    const hasToolCalls = toolCalls.length > 0
    if (message.content !== null && message.content !== undefined || !hasToolCalls) {
      input.push({
        role,
        content: chatContentToResponses(message.content, role, `${path}.content`)
      })
    }

    if (hasToolCalls) {
      toolCalls.forEach((callValue, callIndex) => {
        const callPath = `${path}.tool_calls[${callIndex}]`
        const call = objectAt(callValue, callPath)
        if (call.type !== 'function') {
          throw new OpenAiProtocolTranslationError('仅支持 function tool call', callPath)
        }
        const fn = objectAt(call.function, `${callPath}.function`)
        input.push({
          type: 'function_call',
          call_id: stringAt(call.id, `${callPath}.id`),
          name: stringAt(fn.name, `${callPath}.function.name`),
          arguments: typeof fn.arguments === 'string'
            ? fn.arguments
            : JSON.stringify(fn.arguments ?? {})
        })
      })
    }
  })

  const result: JsonObject = { input }
  copyDefined(body, result, [
    'model', 'stream', 'temperature', 'top_p', 'parallel_tool_calls',
    'metadata', 'user', 'service_tier'
  ])
  const maxTokens = body.max_completion_tokens ?? body.max_tokens
  if (maxTokens !== undefined) result.max_output_tokens = maxTokens
  if (body.tools !== undefined) result.tools = chatToolsToResponses(body.tools)
  if (body.tool_choice !== undefined) result.tool_choice = chatToolChoiceToResponses(body.tool_choice)
  if (body.response_format !== undefined) {
    result.text = { format: chatResponseFormatToResponses(body.response_format) }
  }
  if (body.stop !== undefined) result.stop = body.stop
  return result
}

/** Convert a Responses request body into a Chat Completions request body. */
export function translateResponsesRequestToChatCompletions(bodyValue: unknown): JsonObject {
  const body = objectAt(bodyValue, 'request')
  const messages: JsonObject[] = []
  if (typeof body.instructions === 'string' && body.instructions.length > 0) {
    messages.push({ role: 'developer', content: body.instructions })
  }

  if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input })
  } else {
    const items = arrayAt(body.input, 'input')
    for (const [index, itemValue] of items.entries()) {
      const path = `input[${index}]`
      const item = objectAt(itemValue, path)
      if (item.type === 'function_call') {
        let assistant = messages.at(-1)
        if (!assistant || assistant.role !== 'assistant') {
          assistant = { role: 'assistant', content: null, tool_calls: [] }
          messages.push(assistant)
        }
        if (!Array.isArray(assistant.tool_calls)) assistant.tool_calls = []
        ;(assistant.tool_calls as unknown[]).push({
          id: stringAt(item.call_id ?? item.id, `${path}.call_id`),
          type: 'function',
          function: {
            name: stringAt(item.name, `${path}.name`),
            arguments: typeof item.arguments === 'string'
              ? item.arguments
              : JSON.stringify(item.arguments ?? {})
          }
        })
        continue
      }
      if (item.type === 'function_call_output') {
        messages.push({
          role: 'tool',
          tool_call_id: stringAt(item.call_id, `${path}.call_id`),
          content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')
        })
        continue
      }
      const role = stringAt(item.role, `${path}.role`)
      if (!['system', 'developer', 'user', 'assistant'].includes(role)) {
        throw new OpenAiProtocolTranslationError(`不支持的消息角色“${role}”`, `${path}.role`)
      }
      messages.push({
        role,
        content: responsesContentToChat(item.content, role, `${path}.content`)
      })
    }
  }

  const result: JsonObject = { messages }
  copyDefined(body, result, [
    'model', 'stream', 'temperature', 'top_p', 'parallel_tool_calls',
    'metadata', 'user', 'service_tier', 'stop'
  ])
  if (body.max_output_tokens !== undefined) result.max_completion_tokens = body.max_output_tokens
  if (body.tools !== undefined) result.tools = responsesToolsToChat(body.tools)
  if (body.tool_choice !== undefined) result.tool_choice = responsesToolChoiceToChat(body.tool_choice)
  if (body.text !== undefined) {
    const responseFormat = responsesTextToChatFormat(body.text)
    if (responseFormat) result.response_format = responseFormat
  }
  // Chat streams only report usage when explicitly requested. Responses
  // streams include it in the terminal response event, so ask the Chat
  // upstream for the equivalent information when translating a stream.
  if (body.stream === true) result.stream_options = { include_usage: true }
  return result
}

function chatUsageToResponses(value: unknown): JsonObject | undefined {
  if (!isObject(value)) return undefined
  const result: JsonObject = {
    input_tokens: value.prompt_tokens ?? 0,
    output_tokens: value.completion_tokens ?? 0,
    total_tokens: value.total_tokens ?? 0
  }
  if (isObject(value.prompt_tokens_details)) {
    result.input_tokens_details = {
      cached_tokens: value.prompt_tokens_details.cached_tokens ?? 0
    }
  }
  if (isObject(value.completion_tokens_details)) {
    result.output_tokens_details = {
      reasoning_tokens: value.completion_tokens_details.reasoning_tokens ?? 0
    }
  }
  return result
}

function responsesUsageToChat(value: unknown): JsonObject | undefined {
  if (!isObject(value)) return undefined
  const result: JsonObject = {
    prompt_tokens: value.input_tokens ?? 0,
    completion_tokens: value.output_tokens ?? 0,
    total_tokens: value.total_tokens ?? 0
  }
  if (isObject(value.input_tokens_details)) {
    result.prompt_tokens_details = {
      cached_tokens: value.input_tokens_details.cached_tokens ?? 0
    }
  }
  if (isObject(value.output_tokens_details)) {
    result.completion_tokens_details = {
      reasoning_tokens: value.output_tokens_details.reasoning_tokens ?? 0
    }
  }
  return result
}

function finishReasonToResponsesStatus(reason: unknown): {
  status: string
  incompleteDetails?: JsonObject
} {
  if (reason === 'length') {
    return { status: 'incomplete', incompleteDetails: { reason: 'max_output_tokens' } }
  }
  if (reason === 'content_filter') {
    return { status: 'incomplete', incompleteDetails: { reason: 'content_filter' } }
  }
  return { status: 'completed' }
}

function responsesFinishReason(response: JsonObject, hasToolCalls: boolean): string {
  if (response.status === 'incomplete') {
    const details = isObject(response.incomplete_details) ? response.incomplete_details : {}
    return details.reason === 'max_output_tokens' ? 'length' : 'content_filter'
  }
  return hasToolCalls ? 'tool_calls' : 'stop'
}

function outputTextParts(content: unknown): { text: string; refusal?: string } {
  if (!Array.isArray(content)) return { text: typeof content === 'string' ? content : '' }
  let text = ''
  let refusal: string | undefined
  for (const partValue of content) {
    if (!isObject(partValue)) continue
    if (partValue.type === 'output_text' && typeof partValue.text === 'string') text += partValue.text
    if (partValue.type === 'refusal' && typeof partValue.refusal === 'string') {
      refusal = `${refusal ?? ''}${partValue.refusal}`
    }
  }
  return { text, ...(refusal === undefined ? {} : { refusal }) }
}

/** Convert a successful non-streaming Chat Completions response to Responses. */
export function translateChatCompletionsResponseToResponses(bodyValue: unknown): JsonObject {
  const body = objectAt(bodyValue, 'response')
  const choice = objectAt(arrayAt(body.choices, 'response.choices')[0], 'response.choices[0]')
  const message = objectAt(choice.message, 'response.choices[0].message')
  const id = typeof body.id === 'string' ? body.id : 'response_translated'
  const statusInfo = finishReasonToResponsesStatus(choice.finish_reason)
  const output: JsonObject[] = []
  const content: JsonObject[] = []
  if (typeof message.content === 'string') {
    content.push({ type: 'output_text', text: message.content, annotations: [] })
  }
  if (typeof message.refusal === 'string') content.push({ type: 'refusal', refusal: message.refusal })
  if (content.length > 0 || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
    output.push({
      id: `msg_${id}`,
      type: 'message',
      status: statusInfo.status,
      role: 'assistant',
      content
    })
  }
  if (Array.isArray(message.tool_calls)) {
    message.tool_calls.forEach((callValue, index) => {
      const call = objectAt(callValue, `response.choices[0].message.tool_calls[${index}]`)
      const fn = objectAt(call.function, `response.choices[0].message.tool_calls[${index}].function`)
      output.push({
        id: typeof call.id === 'string' ? call.id : `fc_${id}_${index}`,
        type: 'function_call',
        status: statusInfo.status,
        call_id: typeof call.id === 'string' ? call.id : `call_${id}_${index}`,
        name: stringAt(fn.name, `response.choices[0].message.tool_calls[${index}].function.name`),
        arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {})
      })
    })
  }
  const result: JsonObject = {
    id,
    object: 'response',
    created_at: body.created ?? Math.floor(Date.now() / 1000),
    status: statusInfo.status,
    model: body.model ?? '',
    output,
    parallel_tool_calls: true,
    error: null,
    ...(statusInfo.incompleteDetails ? { incomplete_details: statusInfo.incompleteDetails } : {})
  }
  const usage = chatUsageToResponses(body.usage)
  if (usage) result.usage = usage
  return result
}

/** Convert a successful non-streaming Responses response to Chat Completions. */
export function translateResponsesResponseToChatCompletions(bodyValue: unknown): JsonObject {
  const body = objectAt(bodyValue, 'response')
  const output = arrayAt(body.output, 'response.output')
  let text = ''
  let refusal: string | undefined
  const toolCalls: JsonObject[] = []
  output.forEach((itemValue, index) => {
    const item = objectAt(itemValue, `response.output[${index}]`)
    if (item.type === 'message') {
      const parts = outputTextParts(item.content)
      text += parts.text
      if (parts.refusal !== undefined) refusal = `${refusal ?? ''}${parts.refusal}`
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: typeof item.call_id === 'string' ? item.call_id : item.id,
        type: 'function',
        function: {
          name: item.name,
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {})
        }
      })
    }
  })
  const message: JsonObject = { role: 'assistant', content: text || null }
  if (refusal !== undefined) message.refusal = refusal
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  const result: JsonObject = {
    id: body.id ?? 'chatcmpl_translated',
    object: 'chat.completion',
    created: body.created_at ?? Math.floor(Date.now() / 1000),
    model: body.model ?? '',
    choices: [{
      index: 0,
      message,
      logprobs: null,
      finish_reason: responsesFinishReason(body, toolCalls.length > 0)
    }]
  }
  const usage = responsesUsageToChat(body.usage)
  if (usage) result.usage = usage
  return result
}

interface ParsedSseEvent {
  event?: string
  data: string
}

class SseDecoder {
  private readonly decoder = new TextDecoder()
  private buffer = ''

  push(chunk: Uint8Array): ParsedSseEvent[] {
    this.buffer += this.decoder.decode(chunk, { stream: true })
    return this.drain(false)
  }

  finish(): ParsedSseEvent[] {
    this.buffer += this.decoder.decode()
    return this.drain(true)
  }

  private drain(flush: boolean): ParsedSseEvent[] {
    const events: ParsedSseEvent[] = []
    while (true) {
      const separator = /\r\n\r\n|\n\n|\r\r/.exec(this.buffer)
      if (!separator) break
      const block = this.buffer.slice(0, separator.index)
      this.buffer = this.buffer.slice(separator.index + separator[0].length)
      const event = this.parseBlock(block)
      if (event) events.push(event)
    }
    if (flush && this.buffer.trim()) {
      const event = this.parseBlock(this.buffer)
      this.buffer = ''
      if (event) events.push(event)
    }
    return events
  }

  private parseBlock(block: string): ParsedSseEvent | null {
    let event: string | undefined
    const data: string[] = []
    for (const line of block.split(/\r\n|\n|\r/)) {
      if (!line || line.startsWith(':')) continue
      const separator = line.indexOf(':')
      const field = separator < 0 ? line : line.slice(0, separator)
      const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '')
      if (field === 'event') event = value
      if (field === 'data') data.push(value)
    }
    return data.length > 0 ? { event, data: data.join('\n') } : null
  }
}

function encodeResponsesEvent(type: string, payload: JsonObject): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`
}

function encodeChatChunk(payload: JsonObject): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

interface ChatToolStreamState {
  chatIndex: number
  outputIndex: number
  itemId: string
  callId: string
  name: string
  arguments: string
  added: boolean
  emittedArgumentLength: number
}

class ChatToResponsesSseTranslator {
  private sequence = 0
  private initialized = false
  private finalized = false
  private responseId: string
  private model: string
  private created: number
  private finishReason: unknown = null
  private usage: JsonObject | undefined
  private nextOutputIndex = 0
  private message: JsonObject | null = null
  private messageOutputIndex = -1
  private text = ''
  private refusal = ''
  private textPartAdded = false
  private refusalPartAdded = false
  private readonly tools = new Map<number, ChatToolStreamState>()

  constructor(private readonly options: OpenAiSseTranslationOptions) {
    this.responseId = options.responseId ?? 'response_translated'
    this.model = options.model ?? ''
    this.created = options.created ?? Math.floor(Date.now() / 1000)
  }

  handle(event: ParsedSseEvent): string[] {
    if (this.finalized) return []
    if (event.data === '[DONE]') return this.finalize()
    let chunk: JsonObject
    try {
      chunk = objectAt(JSON.parse(event.data), 'stream event')
    } catch {
      return []
    }
    if (isObject(chunk.error)) {
      this.finalized = true
      return [encodeResponsesEvent('error', { sequence_number: this.sequence++, error: chunk.error })]
    }
    if (typeof chunk.id === 'string') this.responseId = chunk.id
    if (typeof chunk.model === 'string') this.model = chunk.model
    if (typeof chunk.created === 'number') this.created = chunk.created
    const result = this.ensureInitialized()
    if (isObject(chunk.usage)) this.usage = chatUsageToResponses(chunk.usage)
    const choices = Array.isArray(chunk.choices) ? chunk.choices : []
    const choice = isObject(choices[0]) ? choices[0] : undefined
    if (!choice) return result
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      this.finishReason = choice.finish_reason
    }
    const delta = isObject(choice.delta) ? choice.delta : {}
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      result.push(...this.addText(delta.content))
    }
    if (typeof delta.refusal === 'string' && delta.refusal.length > 0) {
      result.push(...this.addRefusal(delta.refusal))
    }
    if (Array.isArray(delta.tool_calls)) {
      delta.tool_calls.forEach((callValue) => {
        if (!isObject(callValue)) return
        const index = typeof callValue.index === 'number' ? callValue.index : 0
        result.push(...this.addToolDelta(index, callValue))
      })
    }
    return result
  }

  flush(): string[] {
    return this.finalized ? [] : this.finalize()
  }

  private response(status = 'in_progress'): JsonObject {
    const output = [
      ...(this.message ? [this.message] : []),
      ...[...this.tools.values()]
        .sort((left, right) => left.outputIndex - right.outputIndex)
        .map((tool) => ({
          id: tool.itemId,
          type: 'function_call',
          status,
          call_id: tool.callId,
          name: tool.name,
          arguments: tool.arguments
        }))
    ].sort((left, right) => {
      const leftIndex = left === this.message ? this.messageOutputIndex :
        [...this.tools.values()].find((tool) => tool.itemId === left.id)?.outputIndex ?? 0
      const rightIndex = right === this.message ? this.messageOutputIndex :
        [...this.tools.values()].find((tool) => tool.itemId === right.id)?.outputIndex ?? 0
      return leftIndex - rightIndex
    })
    const response: JsonObject = {
      id: this.responseId,
      object: 'response',
      created_at: this.created,
      status,
      model: this.model,
      output,
      error: null,
      parallel_tool_calls: true
    }
    if (this.usage) response.usage = this.usage
    return response
  }

  private ensureInitialized(): string[] {
    if (this.initialized) return []
    this.initialized = true
    return [
      encodeResponsesEvent('response.created', {
        sequence_number: this.sequence++,
        response: this.response('in_progress')
      }),
      encodeResponsesEvent('response.in_progress', {
        sequence_number: this.sequence++,
        response: this.response('in_progress')
      })
    ]
  }

  private ensureMessage(): string[] {
    if (this.message) return []
    this.messageOutputIndex = this.nextOutputIndex++
    this.message = {
      id: `msg_${this.responseId}`,
      type: 'message',
      status: 'in_progress',
      role: 'assistant',
      content: []
    }
    return [encodeResponsesEvent('response.output_item.added', {
      sequence_number: this.sequence++,
      output_index: this.messageOutputIndex,
      item: this.message
    })]
  }

  private addText(delta: string): string[] {
    const result = this.ensureMessage()
    if (!this.textPartAdded) {
      this.textPartAdded = true
      result.push(encodeResponsesEvent('response.content_part.added', {
        sequence_number: this.sequence++,
        item_id: this.message!.id,
        output_index: this.messageOutputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] }
      }))
    }
    this.text += delta
    result.push(encodeResponsesEvent('response.output_text.delta', {
      sequence_number: this.sequence++,
      item_id: this.message!.id,
      output_index: this.messageOutputIndex,
      content_index: 0,
      delta
    }))
    return result
  }

  private addRefusal(delta: string): string[] {
    const result = this.ensureMessage()
    const contentIndex = this.textPartAdded ? 1 : 0
    if (!this.refusalPartAdded) {
      this.refusalPartAdded = true
      result.push(encodeResponsesEvent('response.content_part.added', {
        sequence_number: this.sequence++,
        item_id: this.message!.id,
        output_index: this.messageOutputIndex,
        content_index: contentIndex,
        part: { type: 'refusal', refusal: '' }
      }))
    }
    this.refusal += delta
    result.push(encodeResponsesEvent('response.refusal.delta', {
      sequence_number: this.sequence++,
      item_id: this.message!.id,
      output_index: this.messageOutputIndex,
      content_index: contentIndex,
      delta
    }))
    return result
  }

  private addToolDelta(index: number, delta: JsonObject): string[] {
    let tool = this.tools.get(index)
    const fn = isObject(delta.function) ? delta.function : {}
    if (!tool) {
      const itemId = typeof delta.id === 'string' ? delta.id : `fc_${this.responseId}_${index}`
      tool = {
        chatIndex: index,
        outputIndex: this.nextOutputIndex++,
        itemId,
        callId: typeof delta.id === 'string' ? delta.id : `call_${this.responseId}_${index}`,
        name: '',
        arguments: '',
        added: false,
        emittedArgumentLength: 0
      }
      this.tools.set(index, tool)
    }
    if (typeof delta.id === 'string') {
      tool.itemId = delta.id
      tool.callId = delta.id
    }
    if (typeof fn.name === 'string') tool.name += fn.name
    if (typeof fn.arguments === 'string') tool.arguments += fn.arguments

    const result: string[] = []
    // Chat providers may split a function name across multiple deltas. Wait
    // until the argument stream begins (or an explicit empty argument delta)
    // before announcing the Responses item, so its immutable name is complete.
    if (!tool.added && tool.name && (typeof fn.arguments === 'string' || this.finalized)) {
      tool.added = true
      result.push(encodeResponsesEvent('response.output_item.added', {
        sequence_number: this.sequence++,
        output_index: tool.outputIndex,
        item: {
          id: tool.itemId,
          type: 'function_call',
          status: 'in_progress',
          call_id: tool.callId,
          name: tool.name,
          arguments: ''
        }
      }))
    }
    if (tool.added && tool.arguments.length > tool.emittedArgumentLength) {
      const argumentDelta = tool.arguments.slice(tool.emittedArgumentLength)
      tool.emittedArgumentLength = tool.arguments.length
      result.push(encodeResponsesEvent('response.function_call_arguments.delta', {
        sequence_number: this.sequence++,
        item_id: tool.itemId,
        output_index: tool.outputIndex,
        delta: argumentDelta
      }))
    }
    return result
  }

  private finalize(): string[] {
    if (this.finalized) return []
    this.finalized = true
    const result = this.ensureInitialized()
    if (this.message) {
      const content = this.message.content as JsonObject[]
      if (this.textPartAdded) {
        content.push({ type: 'output_text', text: this.text, annotations: [] })
        result.push(encodeResponsesEvent('response.output_text.done', {
          sequence_number: this.sequence++,
          item_id: this.message.id,
          output_index: this.messageOutputIndex,
          content_index: 0,
          text: this.text
        }))
        result.push(encodeResponsesEvent('response.content_part.done', {
          sequence_number: this.sequence++,
          item_id: this.message.id,
          output_index: this.messageOutputIndex,
          content_index: 0,
          part: content[0]
        }))
      }
      if (this.refusalPartAdded) {
        const contentIndex = this.textPartAdded ? 1 : 0
        const part = { type: 'refusal', refusal: this.refusal }
        content.push(part)
        result.push(encodeResponsesEvent('response.refusal.done', {
          sequence_number: this.sequence++,
          item_id: this.message.id,
          output_index: this.messageOutputIndex,
          content_index: contentIndex,
          refusal: this.refusal
        }))
        result.push(encodeResponsesEvent('response.content_part.done', {
          sequence_number: this.sequence++,
          item_id: this.message.id,
          output_index: this.messageOutputIndex,
          content_index: contentIndex,
          part
        }))
      }
      this.message.status = 'completed'
      result.push(encodeResponsesEvent('response.output_item.done', {
        sequence_number: this.sequence++,
        output_index: this.messageOutputIndex,
        item: this.message
      }))
    }
    for (const tool of [...this.tools.values()].sort((left, right) => left.outputIndex - right.outputIndex)) {
      if (!tool.added) {
        tool.name ||= 'unknown_function'
        result.push(...this.addToolDelta(tool.chatIndex, {}))
      }
      result.push(encodeResponsesEvent('response.function_call_arguments.done', {
        sequence_number: this.sequence++,
        item_id: tool.itemId,
        output_index: tool.outputIndex,
        arguments: tool.arguments
      }))
      result.push(encodeResponsesEvent('response.output_item.done', {
        sequence_number: this.sequence++,
        output_index: tool.outputIndex,
        item: {
          id: tool.itemId,
          type: 'function_call',
          status: 'completed',
          call_id: tool.callId,
          name: tool.name,
          arguments: tool.arguments
        }
      }))
    }
    const statusInfo = finishReasonToResponsesStatus(this.finishReason)
    const response = this.response(statusInfo.status)
    if (statusInfo.incompleteDetails) response.incomplete_details = statusInfo.incompleteDetails
    const eventType = statusInfo.status === 'completed' ? 'response.completed' : 'response.incomplete'
    result.push(encodeResponsesEvent(eventType, {
      sequence_number: this.sequence++,
      response
    }))
    return result
  }
}

interface ResponseToolStreamState {
  chatIndex: number
  itemId: string
  callId: string
  name: string
  arguments: string
  announced: boolean
}

class ResponsesToChatSseTranslator {
  private responseId: string
  private model: string
  private created: number
  private roleSent = false
  private finalized = false
  private emittedText = ''
  private readonly textByItem = new Map<string, string>()
  private readonly tools = new Map<string, ResponseToolStreamState>()
  private nextToolIndex = 0

  constructor(private readonly options: OpenAiSseTranslationOptions) {
    this.responseId = options.responseId ?? 'chatcmpl_translated'
    this.model = options.model ?? ''
    this.created = options.created ?? Math.floor(Date.now() / 1000)
  }

  handle(event: ParsedSseEvent): string[] {
    if (this.finalized) return []
    let payload: JsonObject
    try {
      payload = objectAt(JSON.parse(event.data), 'stream event')
    } catch {
      return []
    }
    const response = isObject(payload.response) ? payload.response : undefined
    if (response) this.updateMetadata(response)
    const type = typeof payload.type === 'string' ? payload.type : event.event
    if (type === 'error' || type === 'response.failed') {
      this.finalized = true
      const error = isObject(payload.error)
        ? payload.error
        : isObject(response?.error) ? response.error : { message: 'Responses 上游流式请求失败' }
      return [encodeChatChunk({ error }), 'data: [DONE]\n\n']
    }
    const result = this.ensureRole()

    if (type === 'response.output_text.delta' && typeof payload.delta === 'string') {
      const itemId = typeof payload.item_id === 'string' ? payload.item_id : 'message'
      this.textByItem.set(itemId, `${this.textByItem.get(itemId) ?? ''}${payload.delta}`)
      this.emittedText += payload.delta
      result.push(this.chunk({ content: payload.delta }))
    } else if (type === 'response.output_text.done' && typeof payload.text === 'string') {
      const itemId = typeof payload.item_id === 'string' ? payload.item_id : 'message'
      const emitted = this.textByItem.get(itemId) ?? ''
      if (payload.text.length > emitted.length) {
        const remainder = payload.text.slice(emitted.length)
        this.textByItem.set(itemId, payload.text)
        this.emittedText += remainder
        result.push(this.chunk({ content: remainder }))
      }
    } else if (type === 'response.refusal.delta' && typeof payload.delta === 'string') {
      result.push(this.chunk({ refusal: payload.delta }))
    } else if (type === 'response.output_item.added' && isObject(payload.item) && payload.item.type === 'function_call') {
      result.push(...this.addTool(payload.item))
    } else if (type === 'response.function_call_arguments.delta' && typeof payload.delta === 'string') {
      const tool = this.findTool(payload)
      if (tool) {
        tool.arguments += payload.delta
        result.push(this.chunk({
          tool_calls: [{ index: tool.chatIndex, function: { arguments: payload.delta } }]
        }))
      }
    } else if (type === 'response.output_item.done' && isObject(payload.item) && payload.item.type === 'function_call') {
      result.push(...this.completeTool(payload.item))
    } else if (type === 'response.completed' || type === 'response.incomplete') {
      result.push(...this.finalize(response ?? payload, type === 'response.incomplete'))
    }
    return result
  }

  flush(): string[] {
    return this.finalized ? [] : [...this.ensureRole(), ...this.finalize({}, false)]
  }

  private updateMetadata(response: JsonObject): void {
    if (typeof response.id === 'string') this.responseId = response.id
    if (typeof response.model === 'string') this.model = response.model
    if (typeof response.created_at === 'number') this.created = response.created_at
  }

  private chunk(delta: JsonObject, finishReason: unknown = null): string {
    return encodeChatChunk({
      id: this.responseId,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }]
    })
  }

  private ensureRole(): string[] {
    if (this.roleSent) return []
    this.roleSent = true
    return [this.chunk({ role: 'assistant', content: '' })]
  }

  private addTool(item: JsonObject): string[] {
    const itemId = typeof item.id === 'string'
      ? item.id
      : typeof item.call_id === 'string' ? item.call_id : `tool_${this.nextToolIndex}`
    if (this.tools.has(itemId)) return []
    const tool: ResponseToolStreamState = {
      chatIndex: this.nextToolIndex++,
      itemId,
      callId: typeof item.call_id === 'string' ? item.call_id : itemId,
      name: typeof item.name === 'string' ? item.name : '',
      arguments: typeof item.arguments === 'string' ? item.arguments : '',
      announced: true
    }
    this.tools.set(itemId, tool)
    return [this.chunk({
      tool_calls: [{
        index: tool.chatIndex,
        id: tool.callId,
        type: 'function',
        function: { name: tool.name, arguments: tool.arguments }
      }]
    })]
  }

  private findTool(payload: JsonObject): ResponseToolStreamState | undefined {
    if (typeof payload.item_id === 'string') return this.tools.get(payload.item_id)
    if (typeof payload.output_index === 'number') {
      return [...this.tools.values()].find((tool) => tool.chatIndex === payload.output_index)
    }
    return this.tools.size === 1 ? [...this.tools.values()][0] : undefined
  }

  private completeTool(item: JsonObject): string[] {
    const itemId = typeof item.id === 'string'
      ? item.id
      : typeof item.call_id === 'string' ? item.call_id : ''
    let tool = this.tools.get(itemId)
    const result: string[] = []
    if (!tool) {
      result.push(...this.addTool({ ...item, arguments: '' }))
      tool = this.tools.get(itemId)
    }
    if (!tool) return result
    const completeArguments = typeof item.arguments === 'string' ? item.arguments : tool.arguments
    if (completeArguments.length > tool.arguments.length) {
      const remainder = completeArguments.slice(tool.arguments.length)
      tool.arguments = completeArguments
      result.push(this.chunk({
        tool_calls: [{ index: tool.chatIndex, function: { arguments: remainder } }]
      }))
    }
    return result
  }

  private emitCompletedFallback(response: JsonObject): string[] {
    const output = Array.isArray(response.output) ? response.output : []
    const result: string[] = []
    for (const itemValue of output) {
      if (!isObject(itemValue)) continue
      if (itemValue.type === 'message') {
        const text = outputTextParts(itemValue.content).text
        const itemId = typeof itemValue.id === 'string' ? itemValue.id : 'message'
        const emittedForItem = this.textByItem.get(itemId) ?? ''
        if (text.length > emittedForItem.length) {
          const remainder = text.slice(emittedForItem.length)
          this.textByItem.set(itemId, text)
          this.emittedText += remainder
          result.push(this.chunk({ content: remainder }))
        }
      } else if (itemValue.type === 'function_call') {
        const itemId = typeof itemValue.id === 'string'
          ? itemValue.id
          : typeof itemValue.call_id === 'string' ? itemValue.call_id : ''
        if (!this.tools.has(itemId)) result.push(...this.addTool(itemValue))
        result.push(...this.completeTool(itemValue))
      }
    }
    return result
  }

  private finalize(response: JsonObject, incomplete: boolean): string[] {
    if (this.finalized) return []
    this.updateMetadata(response)
    const result = this.emitCompletedFallback(response)
    const hasTools = this.tools.size > 0
    let finishReason: string
    if (incomplete || response.status === 'incomplete') {
      const details = isObject(response.incomplete_details) ? response.incomplete_details : {}
      finishReason = details.reason === 'max_output_tokens' ? 'length' : 'content_filter'
    } else {
      finishReason = hasTools ? 'tool_calls' : 'stop'
    }
    result.push(this.chunk({}, finishReason))
    const usage = responsesUsageToChat(response.usage)
    if (usage && this.options.includeUsage !== false) {
      result.push(encodeChatChunk({
        id: this.responseId,
        object: 'chat.completion.chunk',
        created: this.created,
        model: this.model,
        choices: [],
        usage
      }))
    }
    result.push('data: [DONE]\n\n')
    this.finalized = true
    return result
  }
}

/**
 * Create a byte TransformStream for an upstream `text/event-stream`. Arbitrary
 * TCP chunk boundaries and multi-line SSE data fields are handled correctly.
 */
export function createOpenAiSseTranslationStream(
  direction: OpenAiProtocolTranslationDirection,
  options: OpenAiSseTranslationOptions = {}
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new SseDecoder()
  const encoder = new TextEncoder()
  const translator = direction === 'chat_to_responses'
    ? new ChatToResponsesSseTranslator(options)
    : new ResponsesToChatSseTranslator(options)
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      for (const event of decoder.push(chunk)) {
        for (const output of translator.handle(event)) controller.enqueue(encoder.encode(output))
      }
    },
    flush(controller) {
      for (const event of decoder.finish()) {
        for (const output of translator.handle(event)) controller.enqueue(encoder.encode(output))
      }
      for (const output of translator.flush()) controller.enqueue(encoder.encode(output))
    }
  })
}

/** Pipe a readable SSE body through the requested protocol conversion. */
export function translateOpenAiSseStream(
  source: ReadableStream<Uint8Array>,
  direction: OpenAiProtocolTranslationDirection,
  options: OpenAiSseTranslationOptions = {}
): ReadableStream<Uint8Array> {
  return source.pipeThrough(createOpenAiSseTranslationStream(direction, options))
}
