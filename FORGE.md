# FORGE.md — Project Conventions
# Place this in your repo root. Every FORGE agent reads it at startup (Function 0).

## Project Identity
**Name:** [Project name]
**Owner:** Kirk
**Purpose:** [One sentence — what problem does this solve?]
**Stage:** [Alpha / Beta / Production]

## VPS Deployment Target
- **Host:** Hostinger VPS
- **Deploy user:** `rooftops` (deploy) or `openclaw` (agent ops)
- **Never use:** root
- **Process manager:** systemd (not PM2)
- **Path:** `/home/[user]/apps/[project-name]/`

## TypeScript Conventions
- Strict mode always: `"strict": true` in tsconfig
- No `any` in public interfaces — use `unknown` + type guards
- Prefer `interface` over `type` for object shapes
- Error handling: wrap external calls in `Result<T, E>` pattern or try/catch with typed errors
- All async functions must handle errors explicitly

## API Patterns
- All API responses: `{ success: boolean, data?: T, error?: string }`
- Validate inputs at the route handler layer with zod
- Log every external API call: timestamp, endpoint, response code

## Database Conventions
- SQLite via `better-sqlite3` (synchronous, fits VPS)
- Migrations in `src/db/migrations/` numbered 001_, 002_, etc.
- Never use raw SQL in business logic — use repository pattern
- Table names: snake_case, plural (e.g., `trading_signals`, `audit_logs`)

## Environment Variables
- All env vars documented in `.env.example` (committed)
- `.env` is gitignored, never committed
- Use `dotenv` at entry point only, not scattered through codebase
- Safety-critical vars (ALPACA_PAPER, API keys) checked at startup

## Testing Standards
- Unit tests for all business logic
- Integration tests for external API clients (mocked)
- Test files: `*.test.ts` adjacent to source files
- Minimum: test the happy path and the primary error case

## Logging
- Use `winston` or structured `console.log` with JSON in production
- Every log entry: `{ timestamp, level, service, message, ...context }`
- Never log credentials or PII

## SQLite Memory Layer (MANDATORY)

**File:** `forge-memory.db` (project root, gitignored, WAL mode)  
**Protocol:** MEMORY_PROTOCOL.md  
**Client:** `scripts/forge/forge-memory-client.ts`

Every agent MUST:
1. Call `mem.entry()` before writing any code (reads DB, marks messages read)
2. Call `mem.exit({...})` after quality gates (writes discoveries, context, story state)
3. Use `mem.setContext()` for any fact the next agent will need to rediscover
4. Use `mem.postMessage('GOTCHA', ...)` for anything that almost broke the build
5. NEVER write credentials, tokens, or API keys to the DB

The DB is initialized and health-checked by `forge.sh` at startup. If the DB is missing or schema version is wrong, forge.sh halts with an error. There is no bypass.

DB tables: `forge_sessions`, `agent_iterations`, `agent_messages`, `context_store`, `discoveries`, `story_state`, `audit_log`

Query the DB directly for debugging:
```bash
sqlite3 forge-memory.db "SELECT * FROM agent_messages WHERE read_at IS NULL;"
sqlite3 forge-memory.db "SELECT * FROM discoveries ORDER BY created_at DESC LIMIT 5;"
npx ts-node scripts/forge/forge-memory-client.ts messages
npx ts-node scripts/forge/forge-memory-client.ts discoveries
```

## What NOT to Do
- Do not use PM2 (use systemd)
- Do not write credentials to disk unencrypted
- Do not disable Fail2ban or UFW
- Do not make live Alpaca API calls in tests
- Do not commit `.env` files
- Do not use `any` types in public interfaces
- Do not skip Function 0 gate
