// REDBEAM app icon: a faceted crystal on a graphite tile, white light in, red beam out.
// Drawn, not rendered: soft gradients and gentle depth, crisp edges.
//
//   node icon.cjs <outdir>
//
// writes icon.svg (full detail, 64 px and up) and icon-small.svg (bigger
// crystal, thicker beams, for 48 px and down), and a 1024 px PNG of each.
// Needs Playwright with its Chromium. pack.py then makes every size.
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')
const out = process.argv[2] ?? '.'

// Continuous-corner (superellipse) tile, Apple's squircle.
function squircle(x0, y0, size, n = 4.4, steps = 360) {
  const r = size / 2, cx = x0 + r, cy = y0 + r
  const pts = []
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * 2 * Math.PI
    const c = Math.cos(t), s = Math.sin(t)
    const x = cx + r * Math.sign(c) * Math.pow(Math.abs(c), 2 / n)
    const y = cy + r * Math.sign(s) * Math.pow(Math.abs(s), 2 / n)
    pts.push(`${x.toFixed(1)} ${y.toFixed(1)}`)
  }
  return 'M' + pts.join('L') + 'Z'
}
const T0 = 44, TS = 936
const TILE = squircle(T0, T0, TS)

function frame({ bg, body, defs = '', rimTop = 0.5, rimBottom = 0.25, shadow = 0.35 }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
<defs>
 <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">${bg.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}</linearGradient>
 <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="${rimTop}"/><stop offset=".18" stop-color="#fff" stop-opacity="0"/><stop offset=".85" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="${rimBottom}"/></linearGradient>
 <radialGradient id="sheen" cx=".5" cy="0" r=".9"><stop offset="0" stop-color="#fff" stop-opacity=".16"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
 <filter id="tileShadow" x="-10%" y="-10%" width="120%" height="125%"><feGaussianBlur in="SourceAlpha" stdDeviation="10"/><feOffset dy="10"/><feComponentTransfer><feFuncA type="linear" slope="${shadow}"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
 <filter id="blur8" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="8"/></filter>
 <filter id="blur18" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="18"/></filter>
 <filter id="blur30" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="30"/></filter>
 <clipPath id="clip"><path d="${TILE}"/></clipPath>
 ${defs}
</defs>
<g filter="url(#tileShadow)">
 <path d="${TILE}" fill="url(#bg)"/>
 <g clip-path="url(#clip)">
  <path d="${TILE}" fill="url(#sheen)"/>
  ${body}
 </g>
 <path d="${TILE}" fill="none" stroke="url(#rim)" stroke-width="5"/>
</g></svg>`
}

// Crystal geometry.
const AP = [512, 226], L = [252, 730], R = [772, 730], C = [512, 590]
const p = (...a) => a.map((q) => q.join(' ')).join(' L ')
const leftAt = (y) => AP[0] - (y - AP[1]) * ((AP[0] - L[0]) / (L[1] - AP[1]))
const rightAt = (y) => AP[0] + (y - AP[1]) * ((R[0] - AP[0]) / (R[1] - AP[1]))

function prism({ lit, mid, dark, edge, edgeOp = 0.9, sm = false }) {
  return `
  <!-- contact shadow -->
  <ellipse cx="512" cy="742" rx="290" ry="26" fill="#000" opacity=".35" filter="url(#blur18)"/>
  <path d="M ${p(AP, L, C)} Z" fill="url(#${lit})"/>
  <path d="M ${p(AP, R, C)} Z" fill="url(#${mid})"/>
  <path d="M ${p(L, R, C)} Z" fill="url(#${dark})"/>
  <path d="M ${p(AP, C)} M ${p(L, C)} M ${p(R, C)}" stroke="#fff" stroke-opacity=".35" stroke-width="3" fill="none"/>
  <path d="M ${p(AP, L, R)} Z" fill="none" stroke="${edge}" stroke-opacity="${edgeOp}" stroke-width="5" stroke-linejoin="round"/>
  <path d="M ${AP[0] - 6} ${AP[1] + 22} L ${leftAt(420) + 14} 420" stroke="#fff" stroke-width="10" stroke-linecap="round" opacity="${sm ? 0 : 0.7}"/>`
}

function beams({ inColor, inW, outA, outB, glow, inY = 548, outY = 500, k = 1 }) {
  const lx = leftAt(inY), rx = rightAt(outY)
  return `
  <!-- outgoing beam, fanning -->
  <path d="M ${rx} ${outY - 14*k} L 1024 ${outY + 50 - 70*k} L 1024 ${outY + 110 + 90*k} L ${rx} ${outY + 16*k} Z" fill="${glow}" opacity=".55" filter="url(#blur30)"/>
  <path d="M ${rx} ${outY - 12*k} L 1024 ${outY + 80 - 60*k} L 1024 ${outY + 100 + 60*k} L ${rx} ${outY + 14*k} Z" fill="url(#${outA})"/>
  <path d="M ${rx} ${outY - 3*k} L 1024 ${outY + 80 - 14*k} L 1024 ${outY + 100 + 14*k} L ${rx} ${outY + 5*k} Z" fill="url(#${outB})"/>
  <!-- incoming beam -->
  <path d="M 0 ${inY + 108} L ${lx} ${inY - inW / 2} L ${lx} ${inY + inW / 2} L 0 ${inY + 108 + inW} Z" fill="${inColor}" opacity=".45" filter="url(#blur8)"/>
  <path d="M 0 ${inY + 108} L ${lx + 2} ${inY - inW / 2} L ${lx + 2} ${inY + inW / 2} L 0 ${inY + 108 + inW} Z" fill="url(#inbeam)"/>`
}

// ---------- A: night prism ----------
const mkA = (sm) => frame({
  bg: [[0, '#454b57'], [0.55, '#23262d'], [1, '#141519']],
  defs: `
 <linearGradient id="litA" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#cfd8e4"/></linearGradient>
 <linearGradient id="midA" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#b9c4d3"/><stop offset="1" stop-color="#7e8a9c"/></linearGradient>
 <linearGradient id="darkA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8a96a8"/><stop offset="1" stop-color="#5b6577"/></linearGradient>
 <linearGradient id="inbeam" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity=".15"/><stop offset=".6" stop-color="#fff" stop-opacity=".9"/><stop offset="1" stop-color="#fff"/></linearGradient>
 <linearGradient id="outA" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff6a55"/><stop offset=".35" stop-color="#ff2d1f"/><stop offset="1" stop-color="#e3170e"/></linearGradient>
 <linearGradient id="outB" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff"/><stop offset=".4" stop-color="#ff9a8a"/><stop offset="1" stop-color="#ff5a46" stop-opacity=".6"/></linearGradient>`,
  body: `<g transform="${sm ? 'translate(512 520) scale(1.14) translate(-512 -520)' : ''}">` + beams({ inColor: '#fff', inW: sm ? 64 : 32, outA: 'outA', outB: 'outB', glow: '#ff2414', k: sm ? 2.4 : 1.25 }) +
    prism({ lit: 'litA', mid: 'midA', dark: 'darkA', edge: '#fff', edgeOp: 0.6, sm }) + '</g>',
})

const files = { 'icon': mkA(false), 'icon-small': mkA(true) }
for (const [n, svg] of Object.entries(files)) fs.writeFileSync(path.join(out, n + '.svg'), svg)

;(async () => {
  const b = await chromium.launch()
  const pg = await b.newPage({ deviceScaleFactor: 1 })
  for (const [n, svg] of Object.entries(files)) {
    await pg.setViewportSize({ width: 1024, height: 1024 })
    await pg.setContent(`<body style="margin:0;background:transparent">${svg}</body>`)
    await pg.screenshot({ path: path.join(out, `${n}-1024.png`), omitBackground: true })
  }
  await b.close()
})()
