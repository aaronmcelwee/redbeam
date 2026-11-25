/** Every sheet a call names, in any of the ways calls name them: `page`, `pages`, `fromPage`..`toPage`, or a `page` on each of `markups`. */
export function pagesNamed(params: Record<string, unknown>, pageCount: number): number[] {
  const out = new Set<number>()
  const add = (v: unknown) => { const n = Number(v); if (v !== undefined && v !== null && v !== '' && Number.isInteger(n) && n >= 0 && n < pageCount) out.add(n) }
  add(params['page'])
  if (Array.isArray(params['pages'])) for (const v of params['pages']) add(v)
  if (params['fromPage'] !== undefined || params['toPage'] !== undefined) {
    const from = Number(params['fromPage'] ?? 0), to = Number(params['toPage'] ?? from)
    if (Number.isInteger(from) && Number.isInteger(to)) for (let n = Math.max(0, from); n <= to && n < pageCount; n++) out.add(n)
  }
  if (Array.isArray(params['markups'])) for (const m of params['markups']) if (typeof m === 'object' && m !== null) add((m as Record<string, unknown>)['page'])
  return [...out]
}
