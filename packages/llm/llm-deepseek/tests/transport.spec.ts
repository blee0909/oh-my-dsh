import { afterEach, describe, expect, it, vi } from 'vitest'

const recycle = vi.fn(async () => undefined)

vi.mock('@deepseek-ai/dsh-http-proxy', () => ({
  recycleGlobalDispatcher: () => recycle(),
}))

const { deepSeekFetch } = await import('../src/transport.ts')

afterEach(() => {
  recycle.mockReset()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('deepSeekFetch', () => {
  it('returns the process fetch response without recycling', async () => {
    const response = new Response('ok', { status: 200 })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
    const init: RequestInit = { method: 'POST' }

    await expect(deepSeekFetch('https://api.deepseek.com/chat/completions', init)).resolves.toBe(response)
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(fetchSpy.mock.calls[0]?.[1]).toBe(init)
    expect(recycle).not.toHaveBeenCalled()
  })

  it('recycles the process dispatcher after a non-abort rejection', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'))

    await expect(deepSeekFetch('https://api.deepseek.com/chat/completions')).rejects.toThrow('fetch failed')
    expect(recycle).toHaveBeenCalledOnce()
  })

  it('does not recycle when the caller already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'))

    await expect(deepSeekFetch('https://api.deepseek.com/chat/completions', { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(recycle).not.toHaveBeenCalled()
  })
})
