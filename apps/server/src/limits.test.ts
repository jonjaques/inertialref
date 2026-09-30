import { describe, expect, it, vi } from 'vitest'
import { allowed, sourceKey, subnet } from './limits.ts'

const from = (address: string) =>
  new Request('https://inertialref.app/api/account', {
    headers: { 'cf-connecting-ip': address },
  })

describe('sourceKey', () => {
  it('keys an IPv6 caller on the /64 it controls, not the address it picked', async () => {
    const one = await sourceKey(from('2001:db8:1:2::1'), 'account')
    expect(await sourceKey(from('2001:db8:1:2:ffff::9'), 'account')).toBe(one)
    expect(
      await sourceKey(from('2001:0db8:0001:0002:0:0:0:1'), 'account'),
    ).toBe(one)
    expect(await sourceKey(from('2001:db8:1:3::1'), 'account')).not.toBe(one)
  })

  it('keys an IPv4 caller on its address, and scopes every key', async () => {
    const one = await sourceKey(from('203.0.113.7'), 'account')
    expect(await sourceKey(from('203.0.113.8'), 'account')).not.toBe(one)
    expect(await sourceKey(from('203.0.113.7'), 'other')).not.toBe(one)
  })
})

describe('subnet', () => {
  it('expands the elided groups before taking the first four', () => {
    expect(subnet('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(subnet('::1')).toBe('0:0:0:0::/64')
    expect(subnet('2001:DB8:A:B:C:D:E:F')).toBe('2001:db8:a:b::/64')
    // IPv4-mapped: the IPv4 address is the caller, not a /64 of zeros.
    expect(subnet('::ffff:203.0.113.7')).toBe('::ffff:203.0.113.7')
  })
})

describe('allowed', () => {
  it('admits when the limiter itself fails, and records it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const limiter = {
        limit: vi.fn(async () => {
          throw new Error('binding unavailable')
        }),
      } as unknown as RateLimit
      expect(await allowed(limiter, 'key')).toBe(true)
      expect(console.error).toHaveBeenCalledOnce()
    } finally {
      vi.restoreAllMocks()
    }
  })
})
