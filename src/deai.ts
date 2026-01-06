/* -----------------------------
   Deterministic "De-AI" Edit Helpers
   (No LLM calls. Heuristic detection + conservative auto-fixes.)
------------------------------ */

type DeAiSeverity = "info" | "warn" | "error";
type DeAiFlagKind =
  | "personification"
  | "vague_language"
  | "abstract_simile"
  | "cliche"
  | "rhetorical_frame"
  | "filler";

type TextSpan = {
  start: number;
  end: number;
  snippet: string;
};

type DeAiFlag = {
  kind: DeAiFlagKind;
  severity: DeAiSeverity;
  message: string;
  spans: TextSpan[];
};

type DeAiEditOp = {
  op: "delete" | "replace";
  span: TextSpan;
  replacement: string | null;
  note: string;
};

const PERSONIFICATION_VERBS = [
  // Intent / pleading / speech
  "begged",
  "pleaded",
  "whispered",
  "muttered",
  "groaned",
  "sighed",
  "gasped",
  "moaned",
  "laughed",
  "sang",
  // “Object doing human-ish action”
  "clung",
  "gripped",
  "held",
  "grabbed",
  "swallowed",
  "breathed",
  "breathing",
  "hung",
  "pressed"
];

const ANTHRO_SOUND_NOUNS = ["gasp", "groan", "sigh", "whisper", "mutter", "moan"];
const ANTHRO_SOUND_ADJ = ["wet", "low", "thin", "sharp", "raw", "soft", "faint", "quiet"];

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
  "beautiful"
];

const BANNED_PHRASES = [
  "like a dream",
  "like a nightmare",
  "time stood still",
  "in the blink of an eye",
  "cold as ice",
  "silence was deafening"
];

const ABSTRACT_SIMILE_TARGETS = ["sin", "evil", "darkness", "the abyss", "death", "fate", "destiny"];

// Moralizing “taglines” that feel AI-ish in prose output
const MORALIZING_TAGLINES = ["damn you", "save you", "ruin you", "haunt you"];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clampSnippet(text: string, start: number, end: number): string {
  const s = Math.max(0, start);
  const e = Math.min(text.length, end);
  return text.slice(s, e);
}

function spansForRegex(text: string, re: RegExp, maxMatches = 60): TextSpan[] {
  const spans: TextSpan[] = [];
  const global = re.global ? re : new RegExp(re.source, re.flags + "g");
  let count = 0;

  for (const m of text.matchAll(global)) {
    const idx = m.index;
    if (idx === undefined) continue;
    const start = idx;
    const end = start + m[0].length;
    spans.push({ start, end, snippet: clampSnippet(text, start, end) });
    count += 1;
    if (count >= maxMatches) break;
  }

  return spans;
}

function phraseSpans(text: string, phrase: string, maxMatches = 40): TextSpan[] {
  const spans: TextSpan[] = [];
  const needle = phrase.toLowerCase();
  const hay = text.toLowerCase();
  let idx = 0;
  let count = 0;

  while (true) {
    const found = hay.indexOf(needle, idx);
    if (found === -1) break;
    const start = found;
    const end = found + phrase.length;
    spans.push({ start, end, snippet: clampSnippet(text, start, end) });
    idx = end;
    count += 1;
    if (count >= maxMatches) break;
  }

  return spans;
}

function generateDeAiReport(text: string): {
  schema_version: 1;
  counts: Record<string, number>;
  flags: DeAiFlag[];
  suggested_ops: DeAiEditOp[];
} {
  const flags: DeAiFlag[] = [];
  const suggested_ops: DeAiEditOp[] = [];

  // 1) Rhetorical flourish: “didn’t just X — it Y”
  const flourishRe = /\b(?:didn’t|didn't)\s+just\b[^—\n]{0,120}—\s*it\b/gi;
  const flourishSpans = spansForRegex(text, flourishRe);
  if (flourishSpans.length > 0) {
    flags.push({
      kind: "rhetorical_frame",
      severity: "warn",
      message:
        'Rhetorical flourish detected ("didn’t just…—it…"). Convert to literal, direct statements.',
      spans: flourishSpans
    });
  }

  // 2) Personification: “the/a/an <noun> <human-ish verb>”
  const personificationRe = new RegExp(
    String.raw`\b(?:the|a|an)\s+[a-z][\w-]*(?:\s+[a-z][\w-]*){0,2}\s+(?:${PERSONIFICATION_VERBS
      .map(escapeRe)
      .join("|")})\b`,
    "gi"
  );
  const personSpans = spansForRegex(text, personificationRe);
  if (personSpans.length > 0) {
    flags.push({
      kind: "personification",
      severity: "warn",
      message:
        "Personification detected. Replace with literal physical behavior (what actually happens) rather than giving objects human intent or speech.",
      spans: personSpans
    });
  }

  // 3) Anthropomorphic sound nouns (“wet gasp”, “a whisper”, etc.)
  const soundNounRe = new RegExp(
    String.raw`\b(?:${ANTHRO_SOUND_ADJ.map(escapeRe).join("|")})\s+(?:${ANTHRO_SOUND_NOUNS
      .map(escapeRe)
      .join("|")})\b|\b(?:a|an)\s+(?:${ANTHRO_SOUND_NOUNS.map(escapeRe).join("|")})\b`,
    "gi"
  );
  const soundSpans = spansForRegex(text, soundNounRe);
  if (soundSpans.length > 0) {
    flags.push({
      kind: "personification",
      severity: "warn",
      message:
        'Anthropomorphic sound noun detected (e.g., "gasp", "whisper"). Replace with neutral sound terms ("sound", "noise", "note") unless the subject is a person speaking/breathing.',
      spans: soundSpans
    });

    // Safe-ish replacements (limited): convert “wet gasp” -> “wet sound”, “a whisper” -> “a trace” (context-neutral)
    for (const sp of soundSpans.slice(0, 25)) {
      const lower = sp.snippet.toLowerCase();
      if (lower.includes("whisper")) {
        suggested_ops.push({
          op: "replace",
          span: sp,
          replacement: sp.snippet.replace(/whisper/gi, "trace"),
          note: 'Replace anthropomorphic noun "whisper" with "trace"'
        });
      } else {
        suggested_ops.push({
          op: "replace",
          span: sp,
          replacement: sp.snippet.replace(/gasp|groan|sigh|mutter|moan/gi, "sound"),
          note: "Replace anthropomorphic sound noun with neutral 'sound'"
        });
      }
    }
  }

  // 4) “whisper of …” construction (very common AI tell)
  const whisperOfSpans = phraseSpans(text, "whisper of");
  if (whisperOfSpans.length > 0) {
    flags.push({
      kind: "personification",
      severity: "warn",
      message:
        'Phrase "whisper of" detected. This often reads as AI-style abstraction. Prefer concrete quantity words (trace, hint, smear) tied to a physical source.',
      spans: whisperOfSpans
    });

    for (const sp of whisperOfSpans.slice(0, 20)) {
      suggested_ops.push({
        op: "replace",
        span: sp,
        replacement: sp.snippet.replace(/whisper of/gi, "trace of"),
        note: 'Replace "whisper of" with "trace of"'
      });
    }
  }

  // 5) Vague language
  const vagueSpans: TextSpan[] = [];
  for (const w of VAGUE_WORDS) {
    const re = new RegExp(String.raw`\b${escapeRe(w)}\b`, "gi");
    vagueSpans.push(...spansForRegex(text, re));
  }
  if (vagueSpans.length > 0) {
    flags.push({
      kind: "vague_language",
      severity: "warn",
      message: "Vague language detected. Replace with specific nouns/verbs or remove if it adds no meaning.",
      spans: vagueSpans.slice(0, 80)
    });
  }

  // 6) Abstract similes: “like sin/fate/…”
  const abstractSimileRe = new RegExp(
    String.raw`\blike\s+(?:${ABSTRACT_SIMILE_TARGETS.map(escapeRe).join("|")})\b`,
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

  // 7) Moralizing taglines: “enough to damn you”, etc.
  const moralizingRe = new RegExp(
    String.raw`\benough\s+to\s+(?:${MORALIZING_TAGLINES.map(escapeRe).join("|")})\b`,
    "gi"
  );
  const moralSpans = spansForRegex(text, moralizingRe);
  if (moralSpans.length > 0) {
    flags.push({
      kind: "abstract_simile",
      severity: "warn",
      message:
        'Moralizing tagline detected (e.g., "enough to damn you"). Replace with literal consequence (what it does to the body, the plan, or the risk).',
      spans: moralSpans
    });
  }

  // 8) Hard-banned cliché phrases
  const clicheSpans: TextSpan[] = [];
  for (const p of BANNED_PHRASES) clicheSpans.push(...phraseSpans(text, p));
  if (clicheSpans.length > 0) {
    flags.push({
      kind: "cliche",
      severity: "error",
      message: "Cliché phrase detected. Remove or replace with specific, original detail.",
      spans: clicheSpans
    });
    for (const sp of clicheSpans.slice(0, 20)) {
      suggested_ops.push({ op: "delete", span: sp, replacement: null, note: "Remove cliché phrase" });
    }
  }

  // 9) Simple filler words (safe deletions)
  const fillerTargets = ["very", "really", "just", "somehow"];
  const fillerSpans: TextSpan[] = [];
  for (const w of fillerTargets) {
    const re = new RegExp(String.raw`\b${escapeRe(w)}\b`, "gi");
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
      suggested_ops.push({ op: "delete", span: sp, replacement: null, note: "Remove filler word" });
    }
  }

  const counts: Record<string, number> = {
    personification: personSpans.length + soundSpans.length + whisperOfSpans.length,
    vague_language: vagueSpans.length,
    abstract_simile: absSpans.length + moralSpans.length,
    cliche: clicheSpans.length,
    rhetorical_frame: flourishSpans.length,
    filler: fillerSpans.length
  };

  return { schema_version: 1, counts, flags, suggested_ops };
}

function applySafeDeAiOps(text: string, ops: DeAiEditOp[]): { text: string; applied: DeAiEditOp[] } {
  // Conservative: apply deletes + only the limited “safe” replacements we generated.
  const safe = ops.slice(0, 120);

  // Apply from end to start so indices stay valid.
  const sorted = safe.slice().sort((a, b) => b.span.start - a.span.start);

  let out = text;
  const applied: DeAiEditOp[] = [];

  for (const op of sorted) {
    if (op.op === "delete") {
      out = out.slice(0, op.span.start) + out.slice(op.span.end);
      applied.push(op);
      continue;
    }

    if (op.op === "replace" && typeof op.replacement === "string") {
      out = out.slice(0, op.span.start) + op.replacement + out.slice(op.span.end);
      applied.push(op);
      continue;
    }
  }

  return { text: out, applied };
}
