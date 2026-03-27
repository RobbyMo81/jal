// Co-authored by FORGE (Session: forge-20260326213245-2999721)
// src/apex/main.ts — JAL-009 Apex REPL entry point
//
// Entry point for: npm run apex
// Starts the ApexRuntime and drops into the interactive REPL.

import { Repl } from './repl/Repl';

async function main(): Promise<void> {
  const repl = new Repl();

  // Handle Ctrl+C gracefully — trigger the same shutdown as 'exit'
  process.on('SIGINT', () => {
    process.stdout.write('\nReceived SIGINT — shutting down...\n');
    repl.runtime.stop().then(() => process.exit(0)).catch(() => process.exit(1));
  });

  await repl.run();
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
