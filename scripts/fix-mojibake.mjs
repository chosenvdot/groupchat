// One-shot repair for cp1252 mojibake introduced by a PowerShell 5.1 Get-Content
// round-trip (UTF-8 read as ANSI). Safe to re-run; deletes itself from history later.
import fs from 'node:fs';
import path from 'node:path';

// real char → its UTF-8 bytes misdecoded as cp1252 (the mojibake to find)
const CP1252 = new Map([
  [0x80, '€'], [0x82, '‚'], [0x83, 'ƒ'], [0x84, '„'], [0x85, '…'],
  [0x86, '†'], [0x87, '‡'], [0x88, 'ˆ'], [0x89, '‰'], [0x8A, 'Š'],
  [0x8B, '‹'], [0x8C, 'Œ'], [0x8E, 'Ž'], [0x91, '‘'], [0x92, '’'],
  [0x93, '“'], [0x94, '”'], [0x95, '•'], [0x96, '–'], [0x97, '—'],
  [0x98, '˜'], [0x99, '™'], [0x9A, 'š'], [0x9B, '›'], [0x9C, 'œ'],
  [0x9E, 'ž'], [0x9F, 'Ÿ'],
]);
function mojibakeOf(ch) {
  return [...Buffer.from(ch, 'utf8')].map((b) => CP1252.get(b) ?? String.fromCharCode(b)).join('');
}
const CHARS = ['—', '→', '✓', '←', '×', '’', '“', '”', '≤', '·'];
const MAP = CHARS.map((c) => [mojibakeOf(c), c]);

let fixed = 0;
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.ts')) {
      let c = fs.readFileSync(p, 'utf8');
      const o = c;
      for (const [m, g] of MAP) c = c.split(m).join(g);
      if (c !== o) {
        fs.writeFileSync(p, c);
        fixed++;
        console.log('repaired:', p);
      }
    }
  }
};
walk('packages/server-core/src');
console.log('fixed files:', fixed);
