import { describe, expect, it } from 'vitest'
import {
  translateAnthropicRequestToChat,
  translateGeminiSseToChat,
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
})
