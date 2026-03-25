# FORGE Memory Protocol
**Classification:** Governance — Mandatory  
**Enforcement:** forge.sh startup, Function 0 gate, quality gate  
**Version:** 1.0

---

## Why This Exists

Every Claude Code instance in the FORGE loop starts with a **clean context window**. Without a structured memory layer, each agent is blind to the work of every agent before it. This creates:

- Repeated mistakes across iterations
- Conflicting implementation choices
- No institutional knowledge accumulation
- Silent failures that compound

The FORGE Memory Protocol solves this. It mandates that all agents **read before writing** and **write before exiting**, using a SQLite database as the shared, stateful working directory of the build process.

---

## The Database

**File:** `forge-memory.db` (project root, gitignored)  
**Engine:** SQLite with WAL mode (safe for concurrent reads)  
**Initialized by:** `forge.sh` on every startup  
**Accessible via:** `forge-memory-client.ts` (TypeScript), `sqlite3` CLI (bash)

This database is the **single source of truth** for agent-to-agent communication during a build session. It is more authoritative than `progress.txt`, more structured than `AGENTS.md`, and faster to query than git history.

---

## Schema — Tables and Purpose

### `forge_sessions`
One row per `forge.sh` invocation. Tracks which feature branch, project, and iteration budget was active. Used to correlate all other records.

### `agent_iterations`
One row per Claude Code instance spawned. Records which story was attempted, when it started/ended, and whether quality gates passed. This is the execution ledger.

### `agent_messages`
**The inter-agent message bus.** An agent writes messages here for future agents. Message types:

| Type | When to Use |
|------|-------------|
| `DISCOVERY` | You found a pattern, convention, or useful fact |
| `GOTCHA` | Something almost broke or will break the next agent |
| `BLOCKER` | You could not complete the story — document why |
| `HANDOFF` | Passing specific state to the next agent on this story |
| `WARNING` | A decision was made that has risk — flag it |
| `DECISION` | An architectural or implementation choice was locked in |

**Rule:** All messages are READ by the next agent during Function 0. Unread messages are surfaced in the startup report.

### `context_store`
Persistent key/value memory that survives context window boundaries. Use for:
- API endpoint URLs discovered
- File paths that are critical
- Config values in use
- Any fact an agent needed to go find that the next agent will also need

### `discoveries`
Structured findings that are automatically compiled into `AGENTS.md` at the end of a session. Each discovery has a `type`: PATTERN, GOTCHA, BLOCKER, DECISION, DEPENDENCY, CONVENTION.

### `story_state`
Extended state per story beyond the `passes` boolean in `prd.json`. Tracks:
- How many times a story has been attempted
- Last error message
- Active blockers (JSON array)
- Free-form notes from the last agent

### `audit_log`
Immutable append-only record of every significant FORGE action. Never updated — only inserted. This is the audit trail Kirk reviews when a build goes wrong.

---

## Agent Obligations (Mandatory)

### On ENTRY (Function 0 — before any code)

```typescript
// 1. Read the startup report
import { readFileSync } from 'fs';
const report = readFileSync('forge-startup-report.md', 'utf-8');

// 2. Query unread messages
const unread = db.query(
  `SELECT * FROM agent_messages WHERE read_at IS NULL ORDER BY created_at ASC`
);

// 3. Query your story's history
const storyState = db.query(
  `SELECT * FROM story_state WHERE story_id = ?`, [storyId]
);

// 4. Scan context store for relevant keys
const context = db.query(
  `SELECT key, value FROM context_store WHERE scope = ? OR scope = 'global'`,
  [`story:${storyId}`]
);
```

### On EXIT (after quality gates, before stopping)

```typescript
// 1. Post your status message
db.run(`
  INSERT INTO agent_messages(from_session, from_iter, story_id, message_type, subject, body)
  VALUES(?, ?, ?, 'STATUS', ?, ?)
`, [sessionId, iteration, storyId, `[${storyId}] completed`, implementationSummary]);

// 2. Record discoveries
discoveries.forEach(d => {
  db.run(`
    INSERT INTO discoveries(story_id, session_id, iteration, type, title, detail)
    VALUES(?, ?, ?, ?, ?, ?)
  `, [storyId, sessionId, iteration, d.type, d.title, d.detail]);
});

// 3. Write context store entries
db.run(`
  INSERT INTO context_store(key, scope, value, value_type, written_by)
  VALUES(?, ?, ?, ?, ?)
  ON CONFLICT(key, scope) DO UPDATE SET value=excluded.value, updated_at=datetime('now')
`, [key, scope, value, valueType, `${sessionId}-${iteration}`]);

// 4. Update story state
db.run(`
  INSERT INTO story_state(story_id, context_notes, last_session)
  VALUES(?, ?, ?)
  ON CONFLICT(story_id) DO UPDATE SET
    context_notes=excluded.context_notes,
    last_session=excluded.last_session,
    last_updated=datetime('now')
`, [storyId, notes, sessionId]);
```

---

## Governance Rules

### Rule 1 — DB Must Exist Before Any Agent Runs
`forge.sh` enforces this. If `forge-memory.db` does not exist or fails health check, the build loop does not start.

### Rule 2 — Read Before Write
Every agent **must** read `forge-startup-report.md` and query unread messages before writing any code. This is verified in the Function 0 gate. An agent that skips this violates the protocol.

### Rule 3 — Write Before Exit
Every agent **must** post at minimum one `STATUS` message and update `story_state` before completing. Stories will not be marked passing if the iteration record in `agent_iterations` has no `completed_at`.

### Rule 4 — Discoveries Are Mandatory for Gotchas
If an agent encounters a gotcha — something that almost broke the build or will affect future agents — it **must** write a `GOTCHA` discovery. The next agent depends on it.

### Rule 5 — Context Store Over Comments
Do not write critical facts as code comments for future agents. Write them to `context_store` with a meaningful key. Comments get overwritten. The DB persists.

### Rule 6 — No Sensitive Data in the DB
`forge-memory.db` is a working file, not a secrets vault. Never write API keys, tokens, passwords, or credentials to any table. Use `context_store` only for structural facts (paths, URLs, config keys — not config values).

### Rule 7 — The DB is Gitignored
`forge-memory.db` is not committed. It is a **runtime working directory**, not source of record. The permanent record is `AGENTS.md` (compiled from `discoveries`) and git history. Archive copies live in `archive/`.

---

## Access Patterns by Role

### forge.sh (orchestrator)
- Initializes DB, creates sessions, tracks iterations
- Generates startup report
- Archives DB on branch change

### Claude Code agents (workers)
- Read startup report and unread messages (Function 0)
- Write discoveries, messages, context entries (on exit)
- Update story state with notes and blockers

### Kirk (engineer)
- Query audit_log after anomalies
- Review discoveries before writing AGENTS.md manually
- Check story_state.attempt_count for stuck stories

---

## Querying the DB (Quick Reference)

```bash
# Open interactive shell
sqlite3 forge-memory.db

# Story pipeline
SELECT story_id, attempt_count, last_updated FROM story_state;

# All unread messages
SELECT message_type, subject, body FROM agent_messages WHERE read_at IS NULL;

# Recent discoveries
SELECT type, title, detail FROM discoveries ORDER BY created_at DESC LIMIT 10;

# Context store
SELECT key, scope, value FROM context_store ORDER BY updated_at DESC;

# Full audit trail for a story
SELECT action, entity, detail, ts FROM audit_log WHERE story_id='US-001' ORDER BY ts;

# Sessions
SELECT id, branch_name, status, started_at, completed_at FROM forge_sessions;
```

---

## TypeScript Client

Import from `forge-memory-client.ts` (in `scripts/forge/`):

```typescript
import { ForgeMemory } from './forge-memory-client';

const mem = new ForgeMemory('forge-memory.db');

// Read obligations
await mem.readStartupReport();
const messages = await mem.getUnreadMessages();
const state = await mem.getStoryState(storyId);

// Write obligations
await mem.postMessage(sessionId, iteration, storyId, 'DISCOVERY', subject, body);
await mem.recordDiscovery(storyId, sessionId, iteration, 'GOTCHA', title, detail);
await mem.setContext(key, value, scope, type);
await mem.updateStoryState(storyId, { contextNotes, lastError });
```

---

*This protocol is enforced by FORGE infrastructure. Agents that skip it produce degraded outputs that compound across iterations. Read. Write. Build.*
