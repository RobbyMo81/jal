const reminderLines = [
  'HITL opt-in reminder',
  '',
  'Explicit opt-in is required before reading any non-default source.',
  '',
  'Use opt-in only when all of these are true:',
  '1. The source is explicitly named for this run or request.',
  '2. The selector is bounded, such as session, date range, run id, or allowlisted view.',
  '3. The purpose is stated.',
  '4. Redaction runs before extraction.',
  '5. The action is recorded in provenance and compile audit output.',
  '',
  'Do not opt in with blanket access such as an entire history file or arbitrary SQL.',
  'Opt-in is per request or per reviewed config, not a standing permission.',
  '',
  'Quick checklist:',
  '- source',
  '- bounded selector',
  '- purpose',
  '- max_items or line limit',
  '- redaction path',
  '- audit record',
  '',
  'Examples:',
  '--include history:session=<session-id>',
  '--include forge-db:view=recent_audit,limit=50',
  '--include shell-snapshot:id=<snapshot-id>',
];

function main(): void {
  console.log(reminderLines.join('\n'));
}

main();