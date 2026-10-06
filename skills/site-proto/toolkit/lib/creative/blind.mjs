// Level 4, Blind test: our creatives mixed with the client's own; the viewer marks the ones they think
// are not the designers'. Hits follow a hypergeometric law by chance, so the verdict is a p-value:
// p >= 0.10 pass, 0.01 <= p < 0.10 borderline, p < 0.01 ours are visible.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const choose = (n, k) => {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
};

// P(X >= k) when n items are picked from N of which K are ours
export function hypergeomTail(N, K, n, k) {
  let p = 0;
  for (let x = k; x <= Math.min(K, n); x++) p += (choose(K, x) * choose(N - K, n - x)) / choose(N, n);
  return Math.min(1, p);
}

export const verdictOf = (p) => (p >= 0.1 ? 'pass' : p >= 0.01 ? 'borderline' : 'visible');

export function scoreBlind(key, picked) {
  const set = new Set(picked.map(Number));
  const hits = key.items.filter((it) => it.ours && set.has(it.n)).length;
  const N = key.items.length, K = key.items.filter((it) => it.ours).length, n = set.size;
  const p = hypergeomTail(N, K, n, hits);
  return { N, K, picked: n, hits, expectedByChance: Math.round(((n * K) / N) * 100) / 100, p: Math.round(p * 10000) / 10000, verdict: verdictOf(p) };
}

function shuffle(list, seed) {
  let s = seed % 2147483647 || 1;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  return list.map((x) => [rnd(), x]).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
}

const TEXT = {
  uk: { title: 'Сліпий тест', lead: (k) => `Позначте ${k}, які, на вашу думку, зробили не дизайнери замовника. Клік — позначити, ще клік — зняти.`, done: 'Готово', left: (k) => `Лишилось позначити: ${k}`, result: 'Результат', hits: 'Влучань', chance: 'випадково в середньому', verdict: { pass: 'Пройдено: наших не видно', borderline: 'Межа: наші трохи вирізняються', visible: 'Наші видно' } },
  en: { title: 'Blind test', lead: (k) => `Mark the ${k} you think the client's designers did not make. Click to mark, click again to unmark.`, done: 'Done', left: (k) => `Left to mark: ${k}`, result: 'Result', hits: 'Hits', chance: 'by chance on average', verdict: { pass: 'Pass: ours are not visible', borderline: 'Borderline: ours stand out a little', visible: 'Ours are visible' } },
};

// Copies every image re-encoded the same way under a neutral name, so neither file names, formats nor
// compression give ours away; writes index.html (self-scoring) and, outside the served folder, the key.
export async function makeBlind({ ours, theirs, outDir, keyFile = path.resolve(outDir) + '.key.json', seed = Date.now() % 100000, lang = 'uk', width = 540 }) {
  const items = shuffle([...ours.map((src) => ({ src, ours: true })), ...theirs.map((src) => ({ src, ours: false }))], seed).map((it, i) => ({ ...it, n: i + 1 }));
  fs.mkdirSync(path.join(outDir, 'img'), { recursive: true });
  for (const it of items) {
    it.file = `img/${String(it.n).padStart(2, '0')}.jpg`;
    await sharp(it.src).flatten({ background: '#ffffff' }).resize({ width }).jpeg({ quality: 90 }).toFile(path.join(outDir, it.file));
  }
  const key = { kind: 'site-proto/blind-test', seed, created: new Date().toISOString(), items: items.map(({ n, src, ours: o, file }) => ({ n, file, src: path.resolve(src).replaceAll('\\', '/'), ours: o })) };
  fs.writeFileSync(keyFile, JSON.stringify(key, null, 2));
  const K = ours.length;
  const t = TEXT[lang] || TEXT.uk;
  // the page knows which are ours only as a hash-free bitmask split from the grid order; fine for an honest viewer
  const mask = items.map((it) => (it.ours ? 1 : 0)).join('');
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t.title}</title>
<style>:root{--bg:#f4f4f2;--fg:#1b1b1b;--mark:#d4145a}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.4 system-ui,sans-serif}
main{max-width:1400px;margin:0 auto;padding:16px}h1{margin:.2em 0}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
figure{margin:0;position:relative;cursor:pointer;border-radius:8px;overflow:hidden;outline:3px solid transparent}figure img{display:block;width:100%}
figure span{position:absolute;left:6px;top:6px;background:#fff;border-radius:99px;padding:0 8px;font-size:13px}figure.on{outline-color:var(--mark)}
figure.on::after{content:'✕';position:absolute;right:8px;top:4px;color:var(--mark);font-weight:700;font-size:22px}
.bar{position:sticky;top:0;background:var(--bg);padding:8px 0;display:flex;gap:16px;align-items:center;z-index:2}button{font:inherit;padding:8px 18px;border-radius:8px;border:0;background:var(--fg);color:#fff;cursor:pointer}
button:disabled{opacity:.35;cursor:default}#out{white-space:pre-wrap;font-family:ui-monospace,monospace;background:#fff;padding:12px;border-radius:8px;display:none}</style></head>
<body><main><h1>${t.title}</h1><p>${t.lead(K)}</p><div class="bar"><span id="left"></span><button id="done" disabled>${t.done}</button></div><pre id="out"></pre>
<div class="grid">${items.map((it) => `<figure data-n="${it.n}"><img src="${it.file}" alt="${it.n}" loading="lazy"><span>${it.n}</span></figure>`).join('')}</div></main>
<script>
const K=${K},N=${items.length},mask='${mask}',T=${JSON.stringify({ left: t.left(0).replace('0', '#'), result: t.result, hits: t.hits, chance: t.chance, verdict: t.verdict })};
const on=new Set(),left=document.getElementById('left'),done=document.getElementById('done'),out=document.getElementById('out');
const C=(n,k)=>{if(k<0||k>n)return 0;let r=1;for(let i=1;i<=k;i++)r=r*(n-k+i)/i;return r};
const tail=(k,n)=>{let p=0;for(let x=k;x<=Math.min(K,n);x++)p+=C(K,x)*C(N-K,n-x)/C(N,n);return Math.min(1,p)};
const draw=()=>{left.textContent=T.left.replace('#',K-on.size);done.disabled=on.size!==K};
document.querySelectorAll('figure').forEach(f=>f.onclick=()=>{const n=+f.dataset.n;if(on.has(n)){on.delete(n);f.classList.remove('on')}else if(on.size<K){on.add(n);f.classList.add('on')}draw()});
done.onclick=()=>{const picked=[...on].sort((a,b)=>a-b);const hits=picked.filter(n=>mask[n-1]==='1').length;const p=tail(hits,picked.length);
const v=p>=0.1?'pass':p>=0.01?'borderline':'visible';out.style.display='block';
out.textContent=T.result+': '+T.verdict[v]+'\\n'+T.hits+': '+hits+' / '+K+' ('+T.chance+' '+(K*K/N).toFixed(2)+'), p = '+p.toFixed(4)+'\\n\\n'+JSON.stringify({picked,hits,p:+p.toFixed(4),verdict:v})};
draw();
</script></body></html>`;
  fs.writeFileSync(path.join(outDir, 'index.html'), html);
  return { dir: outDir, key: keyFile, items: items.length, ours: K, seed };
}
