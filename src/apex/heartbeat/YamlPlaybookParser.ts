// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// src/apex/heartbeat/YamlPlaybookParser.ts — Minimal YAML parser for Apex playbook format
//
// Handles the specific subset used by playbook YAML files:
//   - Top-level scalar key: value pairs (string, number, boolean, null)
//   - Top-level sequences (- item) where items are scalars or flat objects
// Does NOT handle: anchors, multi-document, complex nested structures beyond playbook schema.
//
// Validation: parsePlaybook() validates required fields and returns a typed PlaybookDefinition
// or throws a descriptive ParseError.

import {
  PlaybookDefinition,
  PlaybookTrigger,
  PlaybookStep,
  PlaybookTriggerType,
  RollbackFailurePolicy,
} from '../types';

// ── Parse error ───────────────────────────────────────────────────────────────

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

// ── Internal types ────────────────────────────────────────────────────────────

type YamlScalar = string | number | boolean | null;
// Interfaces allow circular references that type aliases cannot
interface YamlMap {
  [key: string]: YamlNode;
}
// eslint-disable-next-line @typescript-eslint/no-empty-interface
interface YamlList extends Array<YamlNode> {}
type YamlNode = YamlScalar | YamlMap | YamlList;

interface IndexedLine {
  raw: string;
  lineNo: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function indentOf(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  return i;
}

function toScalar(s: string): YamlScalar {
  const t = s.trim();
  if (t === '' || t === 'null' || t === '~') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  const n = Number(t);
  if (!isNaN(n) && t !== '') return n;
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Returns true when the string looks like "identifier: ..." — i.e., the text
 * before the first colon is a valid YAML key with no spaces or quotes.
 * Prevents treating "docker restart my-app" or shell commands containing colons
 * as key–value pairs.
 */
function looksLikeKeyValue(s: string): boolean {
  const colonIdx = s.indexOf(':');
  if (colonIdx === -1) return false;
  const potentialKey = s.slice(0, colonIdx);
  return /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(potentialKey);
}

// ── Core parser ───────────────────────────────────────────────────────────────

/**
 * Strip blank lines and comment lines; preserve line numbers for error messages.
 */
function prepareLines(text: string): IndexedLine[] {
  return text
    .split('\n')
    .map((raw, i) => ({ raw, lineNo: i + 1 }))
    .filter(({ raw }) => {
      const t = raw.trim();
      return t.length > 0 && !t.startsWith('#');
    });
}

/**
 * Parse a top-level YAML document into a flat YamlMap.
 * Only handles the playbook schema — no deep nesting.
 */
function parseDocument(lines: IndexedLine[]): YamlMap {
  const result: YamlMap = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const ind = indentOf(line.raw);
    const trimmed = line.raw.trim();

    // Skip unexpected indented lines at the document root
    if (ind !== 0) {
      i++;
      continue;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1).trim();

    if (rest !== '') {
      result[key] = toScalar(rest);
      i++;
    } else {
      // Block value — collect child lines (indent > 0)
      i++;
      const blockLines: IndexedLine[] = [];
      while (i < lines.length) {
        const bl = lines[i];
        if (!bl.raw.trim()) { i++; continue; }
        if (indentOf(bl.raw) === 0) break;
        blockLines.push(bl);
        i++;
      }
      result[key] = parseBlock(blockLines);
    }
  }

  return result;
}

function parseBlock(lines: IndexedLine[]): YamlNode {
  if (lines.length === 0) return null;
  const firstTrimmed = lines[0].raw.trim();
  if (firstTrimmed.startsWith('- ') || firstTrimmed === '-') {
    return parseSequence(lines);
  }
  return parseMapping(lines);
}

function parseSequence(lines: IndexedLine[]): YamlList {
  if (lines.length === 0) return [];

  const seqIndent = indentOf(lines[0].raw);
  const items: YamlList = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const ind = indentOf(line.raw);
    const trimmed = line.raw.trim();

    if (ind < seqIndent) break;

    if (ind === seqIndent && (trimmed.startsWith('- ') || trimmed === '-')) {
      const afterDash = trimmed.startsWith('- ') ? trimmed.slice(2).trim() : '';
      i++;

      if (afterDash === '') {
        // Multi-line item: look at the next line
        if (i < lines.length) {
          const nextInd = indentOf(lines[i].raw);
          const continuationLines: IndexedLine[] = [];
          while (i < lines.length && indentOf(lines[i].raw) > seqIndent) {
            continuationLines.push(lines[i]);
            i++;
          }
          items.push(parseBlock(continuationLines));
        }
      } else if (looksLikeKeyValue(afterDash)) {
        // First key of a mapping item; collect its siblings
        const itemLines: IndexedLine[] = [];
        itemLines.push({ raw: ' '.repeat(seqIndent + 2) + afterDash, lineNo: line.lineNo });
        while (i < lines.length && indentOf(lines[i].raw) > seqIndent) {
          itemLines.push(lines[i]);
          i++;
        }
        items.push(parseMapping(itemLines));
      } else {
        // Plain scalar item
        items.push(toScalar(afterDash));
      }
    } else {
      i++;
    }
  }

  return items;
}

function parseMapping(lines: IndexedLine[]): YamlMap {
  const obj: YamlMap = {};
  const baseIndent = lines.length > 0 ? indentOf(lines[0].raw) : 0;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const ind = indentOf(line.raw);
    const trimmed = line.raw.trim();

    if (ind < baseIndent) break;
    if (!looksLikeKeyValue(trimmed) && trimmed.indexOf(':') === -1) { i++; continue; }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) { i++; continue; }

    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1).trim();

    if (rest !== '') {
      obj[key] = toScalar(rest);
      i++;
    } else {
      i++;
      const blockLines: IndexedLine[] = [];
      while (i < lines.length && indentOf(lines[i].raw) > ind) {
        blockLines.push(lines[i]);
        i++;
      }
      obj[key] = parseBlock(blockLines);
    }
  }

  return obj;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse raw YAML text into an untyped YamlMap.
 * Throws ParseError on structural problems.
 */
export function parseYamlRaw(text: string): YamlMap {
  const lines = prepareLines(text);
  return parseDocument(lines);
}

const VALID_TRIGGER_TYPES = new Set<string>([
  'high_disk_pressure', 'service_down', 'memory_pressure', 'failed_task', 'custom',
]);

const VALID_ROLLBACK_POLICIES = new Set<string>(['degrade', 'ignore', 'alert']);

/**
 * Parse YAML text and validate it against the PlaybookDefinition schema.
 * Returns a fully-typed PlaybookDefinition or throws ParseError.
 */
export function parsePlaybook(text: string, sourcePath?: string): PlaybookDefinition {
  const loc = sourcePath ? ` in ${sourcePath}` : '';
  let raw: YamlMap;
  try {
    raw = parseYamlRaw(text);
  } catch (e) {
    throw new ParseError(`YAML parse failure${loc}: ${(e as Error).message}`);
  }

  function requireString(key: string): string {
    const v = raw[key];
    if (v === undefined || v === null) throw new ParseError(`Missing required field '${key}'${loc}`);
    if (typeof v !== 'string') throw new ParseError(`Field '${key}' must be a string${loc}, got ${typeof v}`);
    return v;
  }

  function requireBool(key: string): boolean {
    const v = raw[key];
    if (v === undefined || v === null) throw new ParseError(`Missing required field '${key}'${loc}`);
    if (typeof v !== 'boolean') throw new ParseError(`Field '${key}' must be a boolean${loc}, got ${typeof v}`);
    return v;
  }

  function requireNumber(key: string): number {
    const v = raw[key];
    if (v === undefined || v === null) throw new ParseError(`Missing required field '${key}'${loc}`);
    if (typeof v !== 'number') throw new ParseError(`Field '${key}' must be a number${loc}, got ${typeof v}`);
    return v;
  }

  function requireList(key: string): YamlList {
    const v = raw[key];
    if (!Array.isArray(v)) throw new ParseError(`Field '${key}' must be a list${loc}`);
    return v;
  }

  const name = requireString('name');
  const description = requireString('description');
  const staging = requireBool('staging');
  const max_runtime = requireNumber('max_runtime');
  const rollback_failure_policy_raw = requireString('rollback_failure_policy');

  if (!VALID_ROLLBACK_POLICIES.has(rollback_failure_policy_raw)) {
    throw new ParseError(
      `Invalid rollback_failure_policy '${rollback_failure_policy_raw}'${loc}. ` +
      `Must be one of: ${[...VALID_ROLLBACK_POLICIES].join(', ')}`
    );
  }
  const rollback_failure_policy = rollback_failure_policy_raw as RollbackFailurePolicy;

  // triggers
  const triggersRaw = requireList('triggers');
  const triggers: PlaybookTrigger[] = triggersRaw.map((item, idx) => {
    if (typeof item !== 'object' || Array.isArray(item) || item === null) {
      throw new ParseError(`triggers[${idx}] must be a mapping${loc}`);
    }
    const t = item as YamlMap;
    const type = t['type'];
    if (typeof type !== 'string' || !VALID_TRIGGER_TYPES.has(type)) {
      throw new ParseError(
        `triggers[${idx}].type '${type}' is invalid${loc}. ` +
        `Must be one of: ${[...VALID_TRIGGER_TYPES].join(', ')}`
      );
    }
    const trigger: PlaybookTrigger = { type: type as PlaybookTriggerType };
    if (typeof t['service'] === 'string') trigger.service = t['service'] as string;
    if (typeof t['expression'] === 'string') trigger.expression = t['expression'] as string;
    return trigger;
  });

  // steps
  const stepsRaw = requireList('steps');
  const steps: PlaybookStep[] = stepsRaw.map((item, idx) => {
    if (typeof item !== 'object' || Array.isArray(item) || item === null) {
      throw new ParseError(`steps[${idx}] must be a mapping${loc}`);
    }
    const s = item as YamlMap;
    const stepName = s['name'];
    const stepCmd = s['command'];
    if (typeof stepName !== 'string') {
      throw new ParseError(`steps[${idx}].name must be a string${loc}`);
    }
    if (typeof stepCmd !== 'string') {
      throw new ParseError(`steps[${idx}].command must be a string${loc}`);
    }
    const step: PlaybookStep = { name: stepName, command: stepCmd };
    if (typeof s['timeout'] === 'number') step.timeout = s['timeout'] as number;
    return step;
  });

  // rollback_commands
  const rcRaw = requireList('rollback_commands');
  const rollback_commands: string[] = rcRaw.map((item, idx) => {
    if (typeof item !== 'string') {
      throw new ParseError(`rollback_commands[${idx}] must be a string${loc}`);
    }
    return item;
  });

  return {
    name,
    description,
    staging,
    triggers,
    steps,
    max_runtime,
    rollback_commands,
    rollback_failure_policy,
  };
}
