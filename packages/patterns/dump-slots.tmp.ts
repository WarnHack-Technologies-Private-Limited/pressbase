import { readdirSync, readFileSync } from 'node:fs';
import { parseBlocks, serializeBlocks } from '@pressbase/blocks';
import { extractSlots, type Slot } from '@pressbase/slots';

const dir = new URL('./src/patterns/', import.meta.url);
const show = (slots: Slot[], indent = ''): string =>
  slots
    .map((s) =>
      s.kind === 'group'
        ? `${indent}${s.id} [group ${s.role} x${s.items.length} ${s.minItems}-${s.maxItems}${s.flat ? ' flat' : ''}]\n${show(s.items[0] ?? [], `${indent}    `)}`
        : `${indent}${s.id} (${s.kind} ${s.role}${'level' in s && s.level ? ` h${s.level}` : ''}${'maxLength' in s ? ` ≤${s.maxLength}` : ''})`,
    )
    .join('\n');
for (const f of readdirSync(dir).filter((f) => f.endsWith('.html')).sort()) {
  if (process.argv[2] && !f.startsWith(process.argv[2])) continue;
  const content = readFileSync(new URL(f, dir), 'utf8').trim();
  const blocks = parseBlocks(content);
  const same = serializeBlocks(blocks) === content;
  console.log(`== ${f}${same ? '' : '  !! does not round-trip'}\n${show(extractSlots(blocks))}`);
}
