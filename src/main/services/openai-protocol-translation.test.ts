import { describe, expect, it } from 'vitest'
import {
  createOpenAiSseTranslationStream,
  translateChatCompletionsRequestToResponses,
  translateChatCompletionsResponseToResponses,
  translateOpenAiSseStream,
  translateResponsesRequestToChatCompletions,
  translateResponsesResponseToChatCompletions
} from './openai-protocol-translation'

function parseSse(text: string): Array<{ event?: string; data: string; json?: Record<string, unknown> }> {
  return text.trim().split(/\r?\n\r?\n/).map((block) => {
    let event: string | undefined
    const data: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    const joined = data.join('\n')
    return {
      ...(event ? { event } : {}),
      data: joined,
      ...(joined !== '[DONE]' ? { json: JSON.parse(joined) as Record<string, unknown> } : {})
    }
  })
}

async function translateSse(
  input: string,
  direction: 'chat_to_responses' | 'responses_to_chat',
  splitAt = Math.floor(input.length / 2)
): Promise<string> {
  const encoder = new TextEncoder()
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(input.slice(0, splitAt)))
      controller.enqueue(encoder.encode(input.slice(splitAt)))
      controller.close()
    }
  })
  const stream = translateOpenAiSseStream(source, direction)
  return new Response(stream).text()
}

describe('OpenAI request protocol translation', () => {
  it('converts Chat messages, images, tool calls, schemas, and generation settings to Responses', () => {
    const translated = translateChatCompletionsRequestToResponses({
      model: 'public-model',
      messages: [
        { role: 'system', content: 'Be exact.' },
        { role: 'developer', content: 'Return concise output.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is shown?' },
            { type: 'image_url', image_url: { url: 'https://example.test/image.png', detail: 'low' } }
          ]
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"id":1}' }
          }]
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"name":"sample"}' }
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Look up an item',
          parameters: { type: 'object', properties: { id: { type: 'number' } } },
          strict: true
        }
      }],
      tool_choice: { type: 'function', function: { name: 'lookup' } },
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', schema: { type: 'object' }, strict: true }
      },
      temperature: 0.2,
      top_p: 0.8,
      max_completion_tokens: 321,
      parallel_tool_calls: false,
      stream: true
    })

    expect(translated).toMatchObject({
      model: 'public-model',
      temperature: 0.2,
      top_p: 0.8,
      max_output_tokens: 321,
      parallel_tool_calls: false,
      stream: true,
      tool_choice: { type: 'function', name: 'lookup' },
      text: { format: { type: 'json_schema', name: 'answer', strict: true } }
    })
    expect(translated.input).toEqual([
      { role: 'system', content: 'Be exact.' },
      { role: 'developer', content: 'Return concise output.' },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'What is shown?' },
          { type: 'input_image', image_url: 'https://example.test/image.png', detail: 'low' }
        ]
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '{"id":1}'
      },
      { type: 'function_call_output', call_id: 'call_1', output: '{"name":"sample"}' }
    ])
    expect(translated.tools).toEqual([{
      type: 'function',
      name: 'lookup',
      description: 'Look up an item',
      parameters: { type: 'object', properties: { id: { type: 'number' } } },
      strict: true
    }])
  })

  it('converts Responses input, function items, and schema settings to Chat', () => {
    const translated = translateResponsesRequestToChatCompletions({
      model: 'public-model',
      instructions: 'Follow policy.',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Read this' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' }
          ]
        },
        { type: 'function_call', call_id: 'call_2', name: 'search', arguments: '{"q":"x"}' },
        { type: 'function_call_output', call_id: 'call_2', output: 'found' }
      ],
      tools: [{
        type: 'function',
        name: 'search',
        description: 'Search',
        parameters: { type: 'object' },
        strict: true
      }],
      tool_choice: { type: 'function', name: 'search' },
      text: { format: { type: 'json_schema', name: 'result', schema: { type: 'object' } } },
      max_output_tokens: 99,
      temperature: 0,
      top_p: 1
    })

    expect(translated.messages).toEqual([
      { role: 'developer', content: 'Follow policy.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Read this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'high' } }
        ]
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_2',
          type: 'function',
          function: { name: 'search', arguments: '{"q":"x"}' }
        }]
      },
      { role: 'tool', tool_call_id: 'call_2', content: 'found' }
    ])
    expect(translated).toMatchObject({
      max_completion_tokens: 99,
      tool_choice: { type: 'function', function: { name: 'search' } },
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'result', schema: { type: 'object' } }
      }
    })
  })
})

describe('OpenAI non-streaming response protocol translation', () => {
  it('converts Chat text, tools, length status, and usage to Responses', () => {
    const translated = translateChatCompletionsResponseToResponses({
      id: 'chatcmpl_1',
      object: 'chat.completion',
      created: 123,
      model: 'upstream-model',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'partial',
          tool_calls: [{
            id: 'call_weather',
            type: 'function',
            function: { name: 'weather', arguments: '{"city":"SZ"}' }
          }]
        },
        finish_reason: 'length'
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
        prompt_tokens_details: { cached_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 1 }
      }
    })

    expect(translated).toMatchObject({
      id: 'chatcmpl_1',
      object: 'response',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'partial' }] },
        {
          type: 'function_call',
          call_id: 'call_weather',
          name: 'weather',
          arguments: '{"city":"SZ"}'
        }
      ],
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        total_tokens: 14,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 1 }
      }
    })
  })

  it('converts Responses output, tool calls, and usage to Chat', () => {
    const translated = translateResponsesResponseToChatCompletions({
      id: 'resp_1',
      object: 'response',
      created_at: 456,
      status: 'completed',
      model: 'upstream-model',
      output: [
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            { type: 'output_text', text: 'hello ', annotations: [] },
            { type: 'output_text', text: 'world', annotations: [] }
          ]
        },
        {
          id: 'fc_1',
          type: 'function_call',
          call_id: 'call_1',
          name: 'lookup',
          arguments: '{}'
        }
      ],
      usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 }
    })

    expect(translated).toEqual({
      id: 'resp_1',
      object: 'chat.completion',
      created: 456,
      model: 'upstream-model',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'hello world',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{}' }
          }]
        },
        logprobs: null,
        finish_reason: 'tool_calls'
      }],
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 }
    })
  })
})

describe('OpenAI SSE protocol translation', () => {
  it('streams Chat text and tool call deltas as ordered Responses events', async () => {
    const input = [
      {
        id: 'chatcmpl_stream', object: 'chat.completion.chunk', created: 100, model: 'm',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
      },
      {
        id: 'chatcmpl_stream', object: 'chat.completion.chunk', created: 100, model: 'm',
        choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }]
      },
      {
        id: 'chatcmpl_stream', object: 'chat.completion.chunk', created: 100, model: 'm',
        choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }]
      },
      {
        id: 'chatcmpl_stream', object: 'chat.completion.chunk', created: 100, model: 'm',
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0, id: 'call_1', type: 'function',
              function: { name: 'lookup', arguments: '{"q":' }
            }]
          },
          finish_reason: null
        }]
      },
      {
        id: 'chatcmpl_stream', object: 'chat.completion.chunk', created: 100, model: 'm',
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] },
          finish_reason: null
        }]
      },
      {
        id: 'chatcmpl_stream', object: 'chat.completion.chunk', created: 100, model: 'm',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]
      },
      {
        id: 'chatcmpl_stream', object: 'chat.completion.chunk', created: 100, model: 'm',
        choices: [], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }
      }
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n'

    // Split inside an SSE JSON payload to verify arbitrary transport boundaries.
    const output = await translateSse(input, 'chat_to_responses', 73)
    const events = parseSse(output)
    expect(events.slice(0, 2).map((entry) => entry.event)).toEqual([
      'response.created', 'response.in_progress'
    ])
    expect(events.filter((entry) => entry.event === 'response.output_text.delta')
      .map((entry) => entry.json?.delta)).toEqual(['Hel', 'lo'])
    expect(events.filter((entry) => entry.event === 'response.function_call_arguments.delta')
      .map((entry) => entry.json?.delta)).toEqual(['{"q":', '"x"}'])
    const completed = events.at(-1)
    expect(completed?.event).toBe('response.completed')
    expect(completed?.json).toMatchObject({
      response: {
        status: 'completed',
        usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 },
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'Hello' }] },
          { type: 'function_call', name: 'lookup', arguments: '{"q":"x"}' }
        ]
      }
    })
    expect(output).not.toContain('[DONE]')
  })

  it('streams Responses text and tool arguments as valid Chat chunks and terminates once', async () => {
    const response = {
      id: 'resp_stream',
      object: 'response',
      created_at: 200,
      status: 'in_progress',
      model: 'm',
      output: []
    }
    const blocks = [
      ['response.created', { type: 'response.created', response }],
      ['response.output_item.added', {
        type: 'response.output_item.added', output_index: 0,
        item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '' }
      }],
      ['response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"q":'
      }],
      ['response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '"x"}'
      }],
      ['response.output_text.delta', {
        type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'Hi'
      }],
      ['response.completed', {
        type: 'response.completed',
        response: {
          ...response,
          status: 'completed',
          output: [
            { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
            {
              id: 'msg_1', type: 'message', role: 'assistant', status: 'completed',
              content: [{ type: 'output_text', text: 'Hi', annotations: [] }]
            }
          ],
          usage: { input_tokens: 6, output_tokens: 3, total_tokens: 9 }
        }
      }]
    ] as const
    const input = blocks.map(([event, data]) =>
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    ).join('')

    const output = await translateSse(input, 'responses_to_chat', 11)
    const events = parseSse(output)
    expect(events[0].json).toMatchObject({
      id: 'resp_stream',
      choices: [{ delta: { role: 'assistant', content: '' }, finish_reason: null }]
    })
    const argumentDeltas = events.flatMap((entry) => {
      const choices = entry.json?.choices
      if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') return []
      const delta = (choices[0] as { delta?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }).delta
      return delta?.tool_calls?.map((call) => call.function?.arguments).filter(Boolean) ?? []
    })
    expect(argumentDeltas).toEqual(['{"q":', '"x"}'])
    expect(events.some((entry) => JSON.stringify(entry.json).includes('"content":"Hi"'))).toBe(true)
    expect(events.at(-3)?.json).toMatchObject({
      choices: [{ finish_reason: 'tool_calls' }]
    })
    expect(events.at(-2)?.json).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 6, completion_tokens: 3, total_tokens: 9 }
    })
    expect(events.at(-1)?.data).toBe('[DONE]')
    expect(events.filter((entry) => entry.data === '[DONE]')).toHaveLength(1)
  })

  it('exposes a reusable TransformStream constructor', () => {
    expect(createOpenAiSseTranslationStream('chat_to_responses')).toBeInstanceOf(TransformStream)
  })
})
