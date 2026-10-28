#!/usr/bin/env node
// The `pressbase` command. Core runs from its TypeScript sources (as the
// server does, through tsx), so the CLI loads them the same way.
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/main.ts');
const code = await main(process.argv.slice(2));
// Exit once output is flushed: plugins or drivers may hold timers open.
process.stdout.write('', () => process.exit(code));
