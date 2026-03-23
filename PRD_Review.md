# PRD Review: "Project Apex" – Ambiguities & Gaps

## Permission Firewall Tier Definitions (§5.3)

- "Safe installations (npm, pip, apt-get with whitelisted packages)" — the whitelist is never defined. Who maintains it? Where is it stored? How is it updated?
- "File modifications" are Tier 2, but the agent's core function (file operations) requires writing files. The boundary between routine file ops and "destructive" ones is not drawn.
- Tier 3 blocks `sudo`, but many legitimate Docker operations require elevated privileges. How does the agent handle Docker commands that internally escalate?

## Autonomous Heartbeat (§5.1)

- No definition of what "health checks or maintenance" means. What does the agent actually do autonomously? How often? What triggers it to act vs. just report?

## Model Config UI Reuse (§5.4 / §7)

- "Reuse the existing ai-vision configuration GUI from `/home/spoq/ai-vision/tools/config-gui`" — no specification of how it's embedded (subprocess, webview, IPC?), what happens if that path doesn't exist, or how version drift between the two projects is managed.
- §5.4 calls it a GUI; §7 calls it a "Rust TUI component." It's unclear if these are the same thing or two different UIs.

## Capability Fallbacks (§5.4)

- "Degrade gracefully with compatible behavior" when tool-calling is unavailable is undefined. Does the agent switch to prompt-based tool emulation? Refuse the task? Notify the user?

## Auth Contract / CLI Login Hooks (§5.4)

- "CLI login hooks (e.g., `provider login`)" — the hook interface contract is never specified. What's the expected CLI shape? How does Apex invoke and detect success/failure from an arbitrary provider CLI?

## Privacy Contradiction (§3 vs. §6)

- §3 says "only LLM API requests are sent externally," but §6 adds "command descriptions for context" are also transmitted. This is a direct contradiction. What exactly is sent to the LLM? Full command output? Summaries? File contents?

## Crash Recovery (§6)

- "Detect and recover from agent process crashes within 10s" — recovery is undefined. Does the agent resume mid-task? Restart fresh? What happens to in-flight Tier 2 approvals or partially executed commands?

## Task Completion Rate KPI (§8)

- "90% task completion rate" — a "task" is never defined. A single shell command? A multi-step workflow? This metric is unmeasurable without a definition.

## Phased Rollout (§10)

- Phase 2 mentions "tool caching" with no prior mention of what tools are or how caching applies to LLM reasoning.
- Phase 3 mentions "multi-machine coordination via SSH," but SSH access would likely be Tier 3 (network/system config) under the firewall rules — contradiction not resolved.

## AC-03 Provider Switch SLA (§11)

- "Under 2 minutes with no code changes" — switching providers involves OAuth/device-code flows that depend on external browser redirects or CLI prompts. The 2-minute SLA is uncontrolled and potentially impossible to guarantee.

## General Omissions

- No mention of how the agent handles long-running shell commands (streaming output, timeouts, cancellation).
- "Immutable local JSONL file" (§5.3) — immutability mechanism is unspecified. File permissions? Append-only FS flag? This matters for the forensic audit claim.

---

## Agent Memory (Not Addressed)

- No mention of whether the agent has persistent memory across sessions. Does it remember past actions (e.g., a Docker environment set up yesterday), or does every session start from zero?
- The Autonomous Heartbeat implies the agent wakes up and acts independently, but with no memory spec it's unclear what state it has when it wakes. Does it re-read logs? Query Docker state fresh every time?
- No definition of what constitutes the agent's "world model" — how it tracks what it has done, what's in progress, and what it knows about the local system.
- Crash recovery (§6) says recover within 10s, but if the agent has no persistent memory, mid-task state is lost on crash. The PRD doesn't address this.

## Context Window Management (Not Addressed)

- No strategy for long-running sessions. A DevOps agent managing containers over hours will accumulate massive shell output, logs, and conversation history. What gets truncated, summarized, or evicted?
- The agent sends "command descriptions for context" to the LLM (§6), but there's no spec for how much history is included per call — full audit log? Last N commands? A rolling summary?
- No mention of how large tool outputs (e.g., `docker logs`, build output) are handled before being passed to the LLM. Verbatim inclusion could easily blow past any model's context limit.
- With multi-provider support (§5.4), different models have vastly different context limits (e.g., 8K vs. 200K tokens). The normalization layer doesn't address how context management adapts per model.
- The Autonomous Heartbeat creates agent turns with no human message — it's unclear how the agent constructs its own prompt/context for self-initiated actions.

---

**Summary:** The PRD describes a stateful, long-running autonomous agent but specifies it almost entirely as if it were a stateless request/response system. Memory persistence, context window strategy, and state recovery are foundational concerns that must be resolved before implementation begins.
