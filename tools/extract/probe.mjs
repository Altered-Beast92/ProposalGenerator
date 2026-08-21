import fs from 'node:fs';
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const { OPS } = pdfjs;
const NAME = Object.fromEntries(Object.entries(OPS).map(([k, v]) => [v, k]));

const doc = await pdfjs.getDocument({
  data: new Uint8Array(fs.readFileSync(process.argv[2])),
}).promise;
const page = await doc.getPage(Number(process.argv[3]));
const ops = await page.getOperatorList();

const counts = {};
for (let k = 0; k < ops.fnArray.length; k++) {
  const n = NAME[ops.fnArray[k]] ?? ops.fnArray[k];
  counts[n] = (counts[n] || 0) + 1;
}
console.log('operator histogram:');
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log('  ', k, v);

console.log('\nfill-affecting ops in order (first 60):');
let shown = 0;
for (let k = 0; k < ops.fnArray.length && shown < 60; k++) {
  const n = NAME[ops.fnArray[k]] ?? ops.fnArray[k];
  if (/setFill|constructPath|fill|save|restore|transform|clip/i.test(n)) {
    const a = ops.argsArray[k];
    let desc = '';
    if (n === 'constructPath') desc = `ops=[${a[0]}] coords=${JSON.stringify((a[1] || []).slice(0, 8))}`;
    else desc = JSON.stringify(a).slice(0, 90);
    console.log(`  ${k} ${n} ${desc}`);
    shown++;
  }
}
