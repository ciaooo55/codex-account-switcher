import { describe, expect, it } from 'vitest'
import {
  translateAnthropicRequestToChat,
  translateChatRequestToCompletions,
  translateChatResponseForClient,
  translateChatResponseToCompletions,
  translateChatSseToCompletions,
  translateChatSseForClient,
  translateCompletionsRequestToChat,
  translateCompletionsResponseToChat,
  translateCompletionsSseToChat,
  translateGeminiSseToChat,
  translateInteractionsRequestToChat,
  translateInteractionsSseToChat,
  translateOllamaGenerateRequestToChat
} from './protocol-compatibility'

function byteStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      // Deliberately split through an SSE field to cover arbitrary network
      // chunks, not only event-aligned chunks.
      controller.enqueue(bytes.slice(0, Math.max(1, Math.floor(bytes.length / 3))))
      controller.enqueue(bytes.slice(Math.max(1, Math.floor(bytes.length / 3))))
      controller.close()
    }
  })
}

describe('native protocol compatibility', () => {
  it('maps Anthropic tools and Ollama generate prompts into safe Chat requests', () => {
    expect(translateAnthropicRequestToChat({
      model: 'public-model', max_tokens: 99,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'lookup', description: 'find', input_schema: { type: 'object' } }]
    })).toMatchObject({
      model: 'public-model', max_tokens: 99,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }]
    })
    expect(translateOllamaGenerateRequestToChat({ model: 'local', system: 'be brief', prompt: 'hi' })).toMatchObject({
      model: 'local', messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }]
    })
  })

  it('does not drop delta-style Gemini stream chunks', async () => {
    const source = byteStream(
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hel' }] } }] })}\n\n`
      + `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'lo' }] }, finishReason: 'STOP' }] })}\n\n`
    )
    const translated = await new Response(translateGeminiSseToChat(source)).text()
    expect(translated).toContain('"content":"hel"')
    expect(translated).toContain('"content":"lo"')
    expect(translated).toContain('"finish_reason":"stop"')
    expect(translated).toContain('data: [DONE]')
  })

  it('adapts Gemini Interactions requests, results, and both SSE directions', async () => {
    expect(translateInteractionsRequestToChat({
      model: 'public-model', input: [{ type: 'user_input', content: [{ type: 'text', text: 'hi' }] }],
      generation_config: { max_output_tokens: 42 },
      tools: [{ function_declarations: [{ name: 'lookup', parameters: { type: 'object' } }] }]
    })).toMatchObject({
      model: 'public-model', max_tokens: 42,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }]
    })

    expect(translateChatResponseForClient({
      id: 'chat_1', model: 'public-model', choices: [{
        message: { role: 'assistant', content: 'hello', tool_calls: [{ id: 'call_1', function: { name: 'lookup', arguments: '{"q":"x"}' } }] },
        finish_reason: 'tool_calls'
      }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
    }, 'interactions')).toMatchObject({
      id: 'chat_1', object: 'interaction', status: 'requires_action',
      steps: [
        { type: 'model_output', content: [{ type: 'text', text: 'hello' }] },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: { q: 'x' } }
      ]
    })

    const upstream = byteStream(
      `event: interaction.created\ndata: ${JSON.stringify({ event_type: 'interaction.created', interaction: { id: 'int_1', model: 'gemini-real' } })}\n\n`
      + `event: step.start\ndata: ${JSON.stringify({ event_type: 'step.start', index: 0, step: { type: 'model_output' } })}\n\n`
      + `event: step.delta\ndata: ${JSON.stringify({ event_type: 'step.delta', index: 0, delta: { type: 'text_delta', text: 'hello' } })}\n\n`
      + `event: interaction.completed\ndata: ${JSON.stringify({ event_type: 'interaction.completed', interaction: { status: 'completed' } })}\n\n`
    )
    const chat = await new Response(translateInteractionsSseToChat(upstream)).text()
    expect(chat).toContain('"content":"hello"')
    expect(chat).toContain('"finish_reason":"stop"')
    expect(chat).toContain('data: [DONE]')

    const native = await new Response(translateChatSseForClient(byteStream(
      `data: ${JSON.stringify({ id: 'chat_1', model: 'public-model', choices: [{ delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ id: 'chat_1', model: 'public-model', choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`
      + 'data: [DONE]\n\n'
    ), 'interactions')).text()
    expect(native).toContain('event: interaction.created')
    expect(native).toContain('event: step.delta')
    expect(native).toContain('"text":"hi"')
    expect(native).toContain('event: interaction.completed')
    expect(native).toContain('event: done')
  })

  it('adapts legacy OpenAI Completions in both client and upstream directions', async () => {
    expect(translateCompletionsRequestToChat({
      model: 'public-model', prompt: 'hello', max_tokens: 24, temperature: 0.2, stream: true
    })).toMatchObject({
      model: 'public-model', messages: [{ role: 'user', content: 'hello' }], max_tokens: 24, temperature: 0.2, stream: true
    })
    expect(translateChatRequestToCompletions({
      model: 'real-model', messages: [{ role: 'system', content: 'be concise' }, { role: 'user', content: 'hello' }], max_tokens: 24
    })).toMatchObject({ model: 'real-model', prompt: 'System: be concise\nUser: hello', max_tokens: 24 })
    expect(translateCompletionsResponseToChat({
      id: 'cmpl_1', model: 'real-model', choices: [{ text: 'hi back', index: 0, finish_reason: 'stop' }]
    })).toMatchObject({ choices: [{ message: { role: 'assistant', content: 'hi back' }, finish_reason: 'stop' }] })
    expect(translateChatResponseToCompletions({
      id: 'chat_1', model: 'public-model', choices: [{ index: 0, message: { role: 'assistant', content: 'hi back' }, finish_reason: 'stop' }]
    })).toMatchObject({ object: 'text_completion', choices: [{ text: 'hi back', finish_reason: 'stop' }] })

    const upstreamChat = await new Response(translateCompletionsSseToChat(byteStream(
      `data: ${JSON.stringify({ id: 'cmpl_1', model: 'real-model', choices: [{ text: 'hel', finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ id: 'cmpl_1', model: 'real-model', choices: [{ text: 'lo', finish_reason: 'stop' }] })}\n\n`
    ))).text()
    expect(upstreamChat).toContain('"content":"hel"')
    expect(upstreamChat).toContain('"content":"lo"')
    expect(upstreamChat).toContain('data: [DONE]')

    const clientCompletion = await new Response(translateChatSseToCompletions(byteStream(
      `data: ${JSON.stringify({ id: 'chat_1', model: 'public-model', choices: [{ delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ id: 'chat_1', model: 'public-model', choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`
    ))).text()
    expect(clientCompletion).toContain('"object":"text_completion"')
    expect(clientCompletion).toContain('"text":"hi"')
    expect(clientCompletion).toContain('data: [DONE]')

    expect(() => translateCompletionsRequestToChat({ model: 'x', prompt: ['one', 'two'] })).toThrow('多个 prompt')
  })
})
