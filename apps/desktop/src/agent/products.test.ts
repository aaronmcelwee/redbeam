import { describe, expect, it } from 'vitest'
import { readProductType, missingRequiredMeasures } from '@redbeam/domain'
import { describeProduct, describeAllProducts, missingKeys } from './products.js'

describe('describeProduct', () => {
  it('names the keys a baffle needs', () => {
    const d = describeProduct('Baffle')
    expect(d.productType).toBe('baffle')
    const req = d.fields.filter((f) => f.required).map((f) => f.key)
    expect(req).toEqual(['spacing', 'stockLength', 'maxConnectorSpacing'])
    expect(d.fields.find((f) => f.key === 'spacing')).toMatchObject({ unitKey: 'spacingUnit', allowed: ['in', 'ft', 'mm', 'cm', 'm'] })
    expect(d.fields.find((f) => f.key === 'yieldGranularity')?.allowed).toEqual(['full', 'half', 'quarter'])
  })
  it('gives an example every product accepts', () => {
    for (const d of describeAllProducts()) {
      expect(readProductType(d.example)).toBe(d.productType)
      expect(missingRequiredMeasures(d.productType, d.example)).toEqual([])
    }
  })
  it('turns a blocker into keys', () => {
    expect(missingKeys('baffle', { spacing: '6', spacingUnit: 'in' }).map((k) => k.key)).toEqual(['stockLength', 'maxConnectorSpacing'])
  })
})

describe('unknownSpecKeys', () => {
  it('flags keys nothing reads for the product', async () => {
    const { unknownSpecKeys } = await import('./products.js')
    expect(unknownSpecKeys('baffle', { spacing: '6', spacingUnit: 'in', length: "8' L", product: 'Akustus', panelWidth: '24' }))
      .toEqual(['length', 'product', 'panelWidth'])
    expect(unknownSpecKeys('baffle', { productType: 'baffle', scopeDefaultDirection: {}, areaOrigins: {} })).toEqual([])
  })
})
