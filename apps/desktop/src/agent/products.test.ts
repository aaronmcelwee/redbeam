import { describe, expect, it } from 'vitest'
import { readProductType, missingRequiredMeasures } from '@redbeam/domain'
import { describeProduct, describeAllProducts, missingKeys } from './products.js'
import { measuresAsText as asText } from './products.js'

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

describe('measuresAsText', () => {
  it('turns a number sent for a measure into the text the product reads', () => {
    const key = describeProduct('panels').fields.find((f) => f.kind === 'measure' && f.required)!.key
    const specs = asText({ [key]: 24, note: 5, pageDirections: { a: 1 } })
    expect(specs[key]).toBe('24')
    expect(specs['note']).toBe(5)
    expect(specs['pageDirections']).toEqual({ a: 1 })
  })
})

describe('mixed members', () => {
  it('are offered on baffles only, and known keys', async () => {
    const { describeProduct, unknownSpecKeys } = await import('./products.js')
    expect(describeProduct('baffle').options?.map((o) => o.key)).toEqual(['mixedEvery', 'mixedStart', 'mixedLabel', 'memberLabel', 'cloudSlope', 'cloudUpturn', 'cloudUpturnUnit'])
    expect(describeProduct('panels').options?.map((o) => o.key)).toEqual(['cloudSlope', 'cloudUpturn', 'cloudUpturnUnit'])
    expect(describeProduct('linear_parts').options).toBeUndefined()
    expect(unknownSpecKeys('baffle', { mixedEvery: '3', mixedLabel: 'Beam' })).toEqual([])
  })
})
