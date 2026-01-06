export type DeAiSeverity = "info" | "warn" | "error";

export type DeAiFlagKind =
  | "personification"
  | "vague_language"
  | "abstract_simile"
  | "cliche"
  | "rhetorical_frame"
  | "filler";

export type TextSpan = {
  start: number;
  end: number;
  snippet: string;
};

export type DeAiFlag = {
  kind: DeAiFlagKind;
  severity: DeAiSeverity;
  message: string;
  spans: TextSpan[];
};

export type DeAiEditOp = {
  op: "delete" | "replace";
  span: TextSpan;
  replacement: string | null;
  note: string;
};

const PERSONIFICATION_VERBS = [
  "begged",
  "whispered",
  "groaned",
  "sighed",
  "gasped",
  "moaned",
  "screamed",
  "cried",
  "pleaded",
  "laughed",
  "sang"
];

const VAGUE_WORDS = [
  "somehow",
  "suddenly",
  "really",
  "very",
  "just",
  "kind of",
  "sort of",
  "thing",
  "stuff",
  "wrong",
  "strange",
  "dark",
  "beautiful"
];

const BANNED_PHRASES = [
  "like a dream",
  "like a nightmare",
  "time stood still",
  "in the blink of an eye",
  "cold as ice",
  "dead as a doornail",
  "silence was deafening"
];

const ABSTRACT_SIMILE_TARGETS = [
  "sin",
  "evil",
  "darkness",
  "the abyss",
  "death",
  "fate",
  "destiny"
];

function clampSnippet(text: string, start: number, end: number): string {
  const s = Math.max(0, start);
  const e = Math.min(text.length, end);
  return text.slice(s, e);
}

function spansForRegex(text: string, re: RegExp, maxMatches = 50): TextSpan[] {
  const spans: TextSpan[] = [];
  const global = re.global ? re : new RegExp(re.source, re.flags + "g");
  let count = 0;

  for (const m of text.matchAll(global)) {
    if (!m.index && m.index !== 0) continue;
    const start = m.index;
    const end = start + m[0].length;
    spans.push({ start, end, snippet: clampSnippet(text, start, end) });
    count += 1;
    if (count >= maxMatches) break;
  }

  return spans;
}

function phraseSpans(text: string, phrase: string, maxMatches = 50): TextSpan[] {
  const spans: TextSpan[] = [];
  const needle = phrase.toLowerCase();
  const hay = text.toLowerCase();
  let idx = 0;
  let count = 0;

  while (idx >= 0) {
    idx = hay.indexOf(needle, idx);
    if (idx === -1) break;
    const start = idx;
    const end = idx + phrase.length;
    spans.push({ start, end, snippet: clampSnippet(text, start, end) });
    idx = end;
    count += 1;
    if (count >= maxMatches) break;
  }
  return spans;
}

export function generateDeAiReport(text: string): {
  schema_version: 1;
  counts: Record<string, number>;
  flags: DeAiFlag[];
  suggested_ops: DeAiEditOp[];
} {
  const flags: DeAiFlag[] = [];
  const suggested_ops: DeAiEditOp[] = [];

  // Personification: "The X begged/groaned/whispered..."
  // We keep it heuristic: flag, don’t guess a replacement.
  const personificationRe = new RegExp(
    String.raw`\b(?:the|a|an)\s+[a-z][\w-]*\s+(?:${PERSONIFICATION_VERBS.join("|")})\b`,
    "gi"
  );
  const personSpans = spansForRegex(text, personificationRe);
  if (personSpans.length > 0) {
    flags.push({
      kind: "personification",
      severity: "warn",
      message:
        "Personification detected. Replace with literal physical behavior (what actually happens) rather than giving objects human intent.",
      spans: personSpans
    });
  }

  // Vague language
  const vagueSpans: TextSpan[] = [];
  for (const w of VAGUE_WORDS) {
    const re = new RegExp(String.raw`\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\b`, "gi");
    vagueSpans.push(...spansForRegex(text, re));
  }
  if (vagueSpans.length > 0) {
    flags.push({
      kind: "vague_language",
      severity: "warn",
      message:
        "Vague language detected. Replace with specific nouns/verbs or remove the word entirely if it adds no meaning.",
      spans: vagueSpans.slice(0, 80)
    });
  }

  // Abstract similes: "like sin/evil/death/..."
  const abstractSimileRe = new RegExp(
    String.raw`\blike\s+(?:${ABSTRACT_SIMILE_TARGETS.map((s) =>
      s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    ).join("|")})\b`,
    "gi"
  );
  const absSpans = spansForRegex(text, abstractSimileRe);
  if (absSpans.length > 0) {
    flags.push({
      kind: "abstract_simile",
      severity: "warn",
      message:
        "Abstract simile detected. Replace with a concrete comparison anchored to the POV character’s world (physical, practical, specific).",
      spans: absSpans
    });
  }

  // Cliché phrases (hard banned)
  const clicheSpans: TextSpan[] = [];
  for (const p of BANNED_PHRASES) clicheSpans.push(...phraseSpans(text, p));
  if (clicheSpans.length > 0) {
    flags.push({
      kind: "cliche",
      severity: "error",
      message: "Cliché phrase detected. Remove or replace with specific, original detail.",
      spans: clicheSpans
    });
    // For clichés we *can* suggest deletion (safe-ish)
    for (const sp of clicheSpans.slice(0, 20)) {
      suggested_ops.push({
        op: "delete",
        span: sp,
        replacement: null,
        note: "Remove cliché phrase"
      });
    }
  }

  // Rhetorical framing: "you could taste it:" / "you could feel it:" etc.
  const rhetoricalRe = /\byou could (?:taste|feel|hear|see)\s+it\b\s*:?/gi;
  const rhetSpans = spansForRegex(text, rhetoricalRe);
  if (rhetSpans.length > 0) {
    flags.push({
      kind: "rhetorical_frame",
      severity: "info",
      message:
        "Rhetorical framing detected (\"you could ...\"). Prefer direct sensory statements without the filter phrase.",
      spans: rhetSpans
    });
  }

  // Filler words (safe deletions in many cases)
  const fillerTargets = ["very", "really", "just", "somehow"];
  const fillerSpans: TextSpan[] = [];
  for (const w of fillerTargets) {
    const re = new RegExp(String.raw`\b${w}\b`, "gi");
    fillerSpans.push(...spansForRegex(text, re));
  }
  if (fillerSpans.length > 0) {
    flags.push({
      kind: "filler",
      severity: "info",
      message: "Filler detected. Remove unless it changes literal meaning.",
      spans: fillerSpans.slice(0, 80)
    });
    for (const sp of fillerSpans.slice(0, 40)) {
      suggested_ops.push({
        op: "delete",
        span: sp,
        replacement: null,
        note: "Remove filler word"
      });
    }
  }

  const counts: Record<string, number> = {
    personification: personSpans.length,
    vague_language: vagueSpans.length,
    abstract_simile: absSpans.length,
    cliche: clicheSpans.length,
    rhetorical_frame: rhetSpans.length,
    filler: fillerSpans.length
  };

  return {
    schema_version: 1,
    counts,
    flags,
    suggested_ops
  };
}

export function applySafeDeAiOps(text: string, ops: DeAiEditOp[]): { text: string; applied: DeAiEditOp[] } {
  // Apply only deletes (and only those we generated). We avoid “creative replacements” here.
  const deletes = ops.filter((o) => o.op === "delete").slice(0, 80);

  // Sort descending so offsets don’t shift.
  const sorted = deletes.sort((a, b) => b.span.start - a.span.start);

  let out = text;
  for (const op of sorted) {
    out = out.slice(0, op.span.start) + out.slice(op.span.end);
  }

  return { text: out, applied: deletes };
}
