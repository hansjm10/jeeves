#!/usr/bin/env node

import { main } from './cli.js';

main(process.argv.slice(2)).catch((err) => {
  if (err instanceof Error && !err.message.startsWith('Network error:') && !err.message.startsWith('Server returned error:') && err.message !== 'Invalid command') {
    console.error(`Error: ${err.message}`);
  } else if (err instanceof Error && (err.message.startsWith('Network error:') || err.message.startsWith('Server returned error:'))) {
    console.error(`Error: ${err.message}`);
  }
  process.exitCode = 1;
});
