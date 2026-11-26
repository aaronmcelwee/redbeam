import { describe, expect, it } from 'vitest'
import { scopeProductLabel } from './products.js'

describe('scopeProductLabel', () => {
  it('calls a custom assembly measured as counts or lengths Count or Length', () => {
    const specs = { productType: 'custom_assembly' }
    expect(scopeProductLabel({ scopeType: 'count', specifications: specs })).toBe('Count')
    expect(scopeProductLabel({ scopeType: 'linear', specifications: specs })).toBe('Length')
    expect(scopeProductLabel({ scopeType: 'area', specifications: specs })).toBe('Custom Assembly')
  })

  it('leaves every other product its own name', () => {
    expect(scopeProductLabel({ scopeType: 'area', specifications: { productType: 'panels' } })).toBe('Panels')
    expect(scopeProductLabel({ scopeType: 'linear', specifications: { productType: 'linear_parts' } })).toBe('Linear parts')
  })
})
