import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { allocateModelGatewaySlots, CustomApiGateway } from './custom-api-gateway'

const servers: Array<Server | CustomApiGateway> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => {
    if (server instanceof CustomApiGateway) return server.close()
    return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }))
})

async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test upstream did not bind a port')
  return `http://127.0.0.1:${address.port}/v1`
}

describe('custom API gateway', () => {
  it('matches Coc model-shell allocation without changing official model IDs', () => {
    expect(allocateModelGatewaySlots(['deepseek-v4-pro', 'gpt-5.4', 'qwen3-coder'])).toEqual([
      { clientModel: 'gpt-5.4', upstreamModel: 'gpt-5.4' },
      { clientModel: 'gpt-5.6-sol', upstreamModel: 'deepseek-v4-pro' },
      { clientModel: 'gpt-5.6-terra', upstreamModel: 'qwen3-coder' }
    ])
  })

  it('rewrites the client shell to the real upstream model and forwards the response', async () => {
    let forwardedBody = ''
    let forwardedAuth = ''
    const upstream = createServer(async (request, response) => {
      forwardedAuth = request.headers.authorization ?? ''
      for await (const chunk of request) forwardedBody += chunk.toString()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: 'resp_1', output_text: 'hello from upstream' }))
    })
    const upstreamBaseUrl = await listen(upstream)
    const gateway = new CustomApiGateway()
    servers.push(gateway)
    const configured = await gateway.configure({
      upstreamBaseUrl,
      upstreamApiKey: 'upstream-secret',
      token: 'local-gateway-token',
      slots: [{ clientModel: 'gpt-5.6-sol', upstreamModel: 'deepseek-v4-pro' }]
    })

    const response = await fetch(`${configured.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${configured.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'hi' })
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ output_text: 'hello from upstream' })
    expect(forwardedAuth).toBe('Bearer upstream-secret')
    expect(JSON.parse(forwardedBody)).toMatchObject({ model: 'deepseek-v4-pro', input: 'hi' })
  })

  it('rejects requests without the local gateway token before contacting upstream', async () => {
    let upstreamCalls = 0
    const upstream = createServer((_request, response) => {
      upstreamCalls += 1
      response.end('{}')
    })
    const upstreamBaseUrl = await listen(upstream)
    const gateway = new CustomApiGateway()
    servers.push(gateway)
    const configured = await gateway.configure({
      upstreamBaseUrl,
      upstreamApiKey: 'upstream-secret',
      token: 'local-gateway-token',
      slots: []
    })

    const response = await fetch(`${configured.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'hi' })
    })

    expect(response.status).toBe(401)
    expect(upstreamCalls).toBe(0)
  })
})
