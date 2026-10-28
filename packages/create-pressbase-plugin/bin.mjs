#!/usr/bin/env node
// `npx create-pressbase-plugin my-plugin` / `pnpm create pressbase-plugin my-plugin`
import { main } from './src/scaffold.mjs';

process.exitCode = await main(process.argv.slice(2));
