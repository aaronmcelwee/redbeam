const fs=require('fs');const {chromium}=require('playwright');
const img=fs.readFileSync(process.argv[2]).toString('base64');
const svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024"><defs>
<linearGradient id="rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".5"/><stop offset=".3" stop-color="#fff" stop-opacity=".08"/><stop offset=".85" stop-color="#000" stop-opacity=".1"/><stop offset="1" stop-color="#000" stop-opacity=".6"/></linearGradient>
<linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".10"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient>
<filter id="drop" x="-10%" y="-10%" width="120%" height="125%"><feGaussianBlur in="SourceAlpha" stdDeviation="12"/><feOffset dy="12"/><feComponentTransfer><feFuncA type="linear" slope=".5"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" seed="3"/><feColorMatrix values="0 0 0 0 .5  0 0 0 0 .5  0 0 0 0 .5  0 0 0 .06 0"/><feComposite in2="SourceGraphic" operator="in"/></filter><clipPath id="c"><rect x="10" y="6" width="1004" height="1004" rx="210"/></clipPath></defs>
<g filter="url(#drop)"><g clip-path="url(#c)"><image href="data:image/png;base64,${img}" x="${10-(process.argv[4]||0)}" y="${6-(process.argv[5]||0)}" width="1004" height="1004" preserveAspectRatio="xMidYMid slice"/>
<rect x="10" y="6" width="1004" height="502" fill="url(#gloss)"/><rect x="10" y="6" width="1004" height="1004" fill="#fff" filter="url(#n)"/></g>
<rect x="13" y="9" width="998" height="998" rx="207" fill="none" stroke="url(#rim)" stroke-width="6"/></g></svg>`;
(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1024,height:1024}});
await p.setContent(`<body style="margin:0;background:transparent">${svg}</body>`);await p.locator('svg').screenshot({path:process.argv[3],omitBackground:true});await b.close();})();
