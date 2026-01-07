import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

import { prisma } from "./prisma.js";
import { analyzeProse } from "./prose_diagnostics.js";
import {
  ProjectCreateSchema,
  ProseDiagnosticRequestSchema,
  RevisionPlanRequestSchema,
  RevisionPlanSchema,
  DraftDirectiveSchema,
  StyleProfileSchema,
  CharacterSheetSchema,
  ArtifactTypeSchema,
  ArtifactUpsertSchema
} from "./validation.js";
import type { ArtifactType } from "./types.js";
import {
  upsertArtifact,
  getArtifactLatest,
  listArtifacts,
  listArtifactRevisions,
  getArtifactRevision
} from "./artifacts.js";

const DEFAULT_PROJECT_NAME = "default";
const DEFAULT_STYLE_PROFILE_NAME = "prowriter_default";

/**
 * Default operating style for ProWriter.
 * Seeded once into the DB so the GPT can reference it consistently.
 */
const DEFAULT_STYLE_PROFILE = {
  schema_version: 1,
  label: "ProWriter Default (clear, grounded, purposeful)",
  influences: [],
  rhythm: {
    sentence_length_bias:
      "Prefer short/medium sentences. Use a longer sentence only when it increases tension or delivers a deliberate thought-turn.",
    punctuation_habits:
      "Clean punctuation. Avoid em-dash chains, rhetorical fragments, and breathless cadence unless the POV voice demands it.",
    paragraphing:
      "Paragraphs are action units. Break on a turn: decision, reveal, escalation, consequence. No static paragraphs."
  },
  diction: {
    register: "Simple language first. Concrete, precise. Avoid inflated literary phrasing.",
    concreteness_bias:
      "Write what can be seen, heard, touched, done, decided. Replace abstract labels with observable behavior and specific objects.",
    verb_energy: "Active voice by default. Strong verbs over adverbs. Make cause-and-effect obvious.",
    adjective_policy:
      "Minimal modifiers. Use one precise adjective only when it changes meaning. If it’s decorative, cut it."
  },
  constraints: {
    must_avoid: [
      "clichés",
      "throat-clearing and filler",
      "generic emotion labels without behavior",
      "passive voice unless agent is unknown/hidden on purpose",
      "abstract commentary that does not affect action or choice",
      "symmetrical AI cadence and over-balanced sentences",
      "decorative metaphor",
      "cosmic/generalized abstraction (universe, abyss, eternity, void, darkness-as-mood)",
      "dreamlike/fog/shattered/whispered-into-the-night phrasing",
      "moralizing punchlines that do not translate into literal consequence"
    ],
    must_include: [
      "show-dont-tell via behavior + concrete detail + consequence",
      "active verbs and clear agents",
      "every sentence does work (action, tension, character, necessary info, or change)",
      "cause-and-effect clarity",
      "only relevant detail (no neutral description)"
    ]
  }
} as const;

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
  // intent / speech / breath
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
  // “object behaving like a creature”
  "clung",
  "gripped",
  "held",
  "grabbed",
  "swallowed",
  "claimed",
  "answered",
  "breathed",
  "breathing",
  "pressed",
  "hung"
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
  "silence was deafening",
  "rotten at the core"
];

const ABSTRACT_SIMILE_TARGETS = ["sin", "evil", "darkness", "the abyss", "death", "fate", "destiny"];

// moralizing “tagline” endings that read AI-ish
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

  // A) rhetorical flourish: “didn’t just X — it Y”
  const flourishRe = /\b(?:didn’t|didn't)\s+just\b[^—\n]{0,140}—\s*it\b/gi;
  const flourishSpans = spansForRegex(text, flourishRe);
  if (flourishSpans.length > 0) {
    flags.push({
      kind: "rhetorical_frame",
      severity: "warn",
      message: 'Rhetorical flourish detected ("didn’t just…—it…"). Convert to literal, direct statements.',
      spans: flourishSpans
    });
  }

  // B) filter phrasing: “you could taste/feel/hear/see …”
  const filterRe = /\byou could (?:taste|feel|hear|see)\b/gi;
  const filterSpans = spansForRegex(text, filterRe);
  if (filterSpans.length > 0) {
    flags.push({
      kind: "rhetorical_frame",
      severity: "warn",
      message: 'Filter phrase detected ("you could ..."). Prefer direct sensory statements without the filter.',
      spans: filterSpans
    });
  }

  // C) personification: “the/a/an <noun> <human-ish verb>”
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
        "Personification detected. Replace with literal physical behavior rather than giving objects human intent or speech.",
      spans: personSpans
    });
  }

  // D) anthropomorphic sound nouns (“wet sigh”, “a whisper”, etc.)
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
        'Anthropomorphic sound noun detected (e.g., "sigh", "gasp", "whisper"). Replace with neutral sound terms unless the subject is a person.',
      spans: soundSpans
    });

    // conservative replacements (limited)
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

  // E) “whisper of …” construction
  const whisperOfSpans = phraseSpans(text, "whisper of");
  if (whisperOfSpans.length > 0) {
    flags.push({
      kind: "personification",
      severity: "warn",
      message:
        'Phrase "whisper of" detected. Prefer concrete quantity words (trace, hint, smear) tied to a physical source.',
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

  // F) vague language
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

  // G) abstract similes: “like sin/fate/…”
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
        "Abstract simile detected. Replace with a concrete comparison anchored to the POV character’s world.",
      spans: absSpans
    });
  }

  // H) moralizing taglines: “enough to damn you”
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
        'Moralizing tagline detected (e.g., "enough to damn you"). Replace with literal consequence (risk, cost, effect).',
      spans: moralSpans
    });
  }

  // I) banned phrases / clichés
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

  // J) filler words
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
    rhetorical_frame: flourishSpans.length + filterSpans.length,
    filler: fillerSpans.length
  };

  return { schema_version: 1, counts, flags, suggested_ops };
}

function applySafeDeAiOps(text: string, ops: DeAiEditOp[]): { text: string; applied: DeAiEditOp[] } {
  // Conservative: apply deletes + only the limited replacements we generated.
  const safe = ops.slice(0, 140);
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

/* -----------------------------
   Core helpers
------------------------------ */

function badRequest(message: string): never {
  const err = new Error(message);
  // @ts-expect-error fastify reads statusCode
  err.statusCode = 400;
  throw err;
}

function asArtifactType(s: string): ArtifactType {
  const parsed = ArtifactTypeSchema.safeParse(s);
  if (!parsed.success) badRequest("Invalid artifact type");
  return parsed.data;
}

function nonEmptyQueryString(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

async function ensureDefaultStyleProfile(projectId: string): Promise<void> {
  const existing = await prisma.artifact.findFirst({
    where: { projectId, type: "style_profile", name: DEFAULT_STYLE_PROFILE_NAME },
    select: { id: true }
  });

  if (existing) return;

  try {
    await upsertArtifact({
      projectId,
      type: "style_profile",
      name: DEFAULT_STYLE_PROFILE_NAME,
      schemaVersion: 1,
      payload: DEFAULT_STYLE_PROFILE
    });
  } catch {
    // race-safe
  }
}

async function getOrCreateDefaultProjectId(): Promise<string> {
  const existing = await prisma.project.findFirst({
    where: { name: DEFAULT_PROJECT_NAME }
  });

  const projectId = existing
    ? existing.id
    : (await prisma.project.create({ data: { name: DEFAULT_PROJECT_NAME } })).id;

  await ensureDefaultStyleProfile(projectId);
  return projectId;
}

/* -----------------------------
   Routes
------------------------------ */

export async function registerRoutes(app: FastifyInstance) {
  // Deterministic error responses
  app.setErrorHandler((error, _req, reply) => {
    const status = (error as any).statusCode ?? 500;
    reply.code(status).send({
      error: status === 500 ? "internal_error" : "bad_request"
    });
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/", async () => ({
    ok: true,
    service: "prowriter-backend",
    endpoints: ["/health", "/openapi.yaml"]
  }));

  app.get("/openapi.yaml", async (_req, reply) => {
    const p = path.join(process.cwd(), "openapi.yaml");
    if (!fs.existsSync(p)) {
      reply.code(404).type("application/json").send({ error: "not_found" });
      return;
    }
    const yml = fs.readFileSync(p, "utf8");
    reply.type("text/yaml").send(yml);
  });

  // -------------------------
  // Default-project routes (NO projectId required)
  // -------------------------

  app.get("/v1/canon-digest", async () => {
    const projectId = await getOrCreateDefaultProjectId();
    const artifacts = await listArtifacts(projectId);

    return {
      project_id: projectId,
      style_profiles: artifacts.filter((a) => a.type === "style_profile").map((a) => a.name),
      characters: artifacts.filter((a) => a.type === "character_sheet").map((a) => a.name),
      draft_directives: artifacts.filter((a) => a.type === "draft_directive").map((a) => a.name)
    };
  });

  app.get("/v1/artifacts", async (req) => {
    const projectId = await getOrCreateDefaultProjectId();
    const q = req.query as { type?: string };
    const type = q.type ? asArtifactType(q.type) : undefined;
    return { artifacts: await listArtifacts(projectId, type) };
  });

  app.put("/v1/artifacts/:type/:name", async (req) => {
    const projectId = await getOrCreateDefaultProjectId();
    const { type, name } = req.params as { type: string; name: string };

    const artifactType = asArtifactType(type);

    const parsedBody = ArtifactUpsertSchema.safeParse(req.body);
    if (!parsedBody.success) badRequest("Invalid artifact upsert body");
    const body = parsedBody.data;

    return upsertArtifact({
      projectId,
      type: artifactType,
      name,
      schemaVersion: body.schema_version,
      payload: body.payload
    });
  });

  app.get("/v1/artifacts/:type/:name", async (req) => {
    const projectId = await getOrCreateDefaultProjectId();
    const { type, name } = req.params as { type: string; name: string };

    const artifactType = asArtifactType(type);

    const latest = await getArtifactLatest({ projectId, type: artifactType, name });
    if (!latest) return { error: "not_found" };
    return latest;
  });

  app.get("/v1/artifacts/:type/:name/revisions", async (req) => {
    const projectId = await getOrCreateDefaultProjectId();
    const { type, name } = req.params as { type: string; name: string };

    const artifactType = asArtifactType(type);

    const list = await listArtifactRevisions({ projectId, type: artifactType, name });
    if (!list) return { error: "not_found" };
    return { revisions: list };
  });

  app.get("/v1/artifacts/:type/:name/revisions/:revision", async (req) => {
    const projectId = await getOrCreateDefaultProjectId();
    const { type, name, revision } = req.params as { type: string; name: string; revision: string };

    const artifactType = asArtifactType(type);

    const revNum = Number(revision);
    if (!Number.isInteger(revNum) || revNum < 1) badRequest("revision must be a positive integer");

    const item = await getArtifactRevision({
      projectId,
      type: artifactType,
      name,
      revision: revNum
    });

    if (!item) return { error: "not_found" };
    return item;
  });

  app.put("/v1/style-profiles/:profileName", async (req) => {
    const projectId = await getOrCreateDefaultProjectId();
    const { profileName } = req.params as { profileName: string };

    const parsed = StyleProfileSchema.safeParse(req.body);
    if (!parsed.success) badRequest("Invalid style profile");
    const data = parsed.data;

    return upsertArtifact({
      projectId,
      type: "style_profile",
      name: profileName,
      schemaVersion: data.schema_version,
      payload: data
    });
  });

  app.get("/v1/style-profiles/:profileName", async (req) => {
    const projectId = await getOrCreateDefaultProjectId();
    const { profileName } = req.params as { profileName: string };

    const latest = await getArtifactLatest({ projectId, type: "style_profile", name: profileName });
    if (!latest) return { error: "not_found" };
    return latest;
  });

  app.put("/v1/character-sheets/:sheetName", async (req) => {
    const projectId = await getOrCreateDefaultProjectId();
    const { sheetName } = req.params as { sheetName: string };

    const parsed = CharacterSheetSchema.safeParse(req.body);
    if (!parsed.success) badRequest("Invalid character sheet");
    const data = parsed.data;

    return upsertArtifact({
      projectId,
      type: "character_sheet",
      name: sheetName,
      schemaVersion: data.schema_version,
      payload: data
    });
  });

  app.get("/v1/character-sheets/:sheetName", async (req) => {
    const projectId = await getOrCreateDefaultProjectId();
    const { sheetName } = req.params as { sheetName: string };

    const latest = await getArtifactLatest({ projectId, type: "character_sheet", name: sheetName });
    if (!latest) return { error: "not_found" };
    return latest;
  });

  app.post("/v1/draft-directives", async (req) => {
    const projectId = await getOrCreateDefaultProjectId();
    const q = req.query as { directiveName?: string };

    const directiveName = nonEmptyQueryString(q.directiveName, "current");

    const parsed = DraftDirectiveSchema.safeParse(req.body);
    if (!parsed.success) badRequest("Invalid draft directive");
    const data = parsed.data;

    return upsertArtifact({
      projectId,
      type: "draft_directive",
      name: directiveName,
      schemaVersion: data.schema_version,
      payload: data
    });
  });

  app.post("/v1/revision-plans", async (req) => {
    const projectId = await getOrCreateDefaultProjectId();
    const q = req.query as { planName?: string };

    const planName = nonEmptyQueryString(q.planName, "current");

    const parsed = RevisionPlanRequestSchema.safeParse(req.body);
    if (!parsed.success) badRequest("Invalid revision plan request");
    const reqData = parsed.data;

    const mode = reqData.mode;

    const rubricBase: string[] = [
      "Clarity beats beauty; rewrite anything that is pretty but unclear",
      "Show, don't tell (behavior + concrete detail + consequence)",
      "Prefer active voice and strong verbs; cut unnecessary adverbs",
      "Use simple language whenever possible; avoid inflated phrasing",
      "Cut filler and redundant qualifiers aggressively",
      "Avoid clichés completely",
      "Every sentence must do work (action, tension, character, necessary info, or change)",
      "Maintain continuity and avoid inventing new facts",
      "Ensure cause-and-effect is clear at the paragraph level",
      "Remove decorative metaphor that does not clarify meaning"
    ];

    const modeRubric: Record<string, string[]> = {
      humanize: [
        "Replace generic reactions with character-specific behavior and subtext",
        "Avoid melodrama; keep emotional shifts motivated by events",
        "Keep voice consistent and avoid robotic symmetry"
      ],
      marketability: [
        "Tighten openings and transitions; remove throat-clearing",
        "Sharpen objective, obstacle, and stakes early",
        "Prioritize readability and tension over ornament"
      ],
      tighten: [
        "Remove redundancy without losing meaning",
        "Compress neutral description; keep only relevant details",
        "Prefer one precise image over several weaker ones"
      ],
      voice_match: [
        "Align diction and rhythm to the chosen style constraints",
        "Apply techniques without copying phrasing",
        "Keep metaphor budget near zero unless it clarifies"
      ],
      clarity: [
        "Disambiguate pronouns and causal links",
        "Ground setting and action so the reader can visualize sequence",
        "Replace abstract nouns with concrete actions"
      ],
      dialogue_punchup: [
        "Dialogue must have leverage and subtext",
        "Avoid on-the-nose exposition; hide info inside conflict",
        "Track power shifts per exchange"
      ],
      pacing: [
        "Compress low-tension passages; expand high-tension turns",
        "End on change: decision, reveal, reversal, escalation",
        "Make each paragraph move the situation"
      ]
    };

    const planCandidate = {
      schema_version: reqData.schema_version,
      mode,
      rubric: [...rubricBase, ...(modeRubric[mode] ?? [])],
      risks_to_avoid: [
        "Vague sensory filler",
        "Unmotivated emotional swings",
        "Abstract metaphors that do not clarify",
        "Continuity contradictions",
        "Cliché phrasing",
        "Moralizing punchlines"
      ],
      recommended_passes: ["Continuity pass", "Clarity pass", "Pacing pass", "Line-level tightening pass"]
    };

    const plan = RevisionPlanSchema.parse(planCandidate);

    return upsertArtifact({
      projectId,
      type: "revision_plan",
      name: planName,
      schemaVersion: plan.schema_version,
      payload: plan
    });
  });

  app.post("/v1/diagnostics/prose", async (req) => {
    const projectId = await getOrCreateDefaultProjectId();

    const parsed = ProseDiagnosticRequestSchema.safeParse(req.body);
    if (!parsed.success) badRequest("Invalid diagnostic request");
    const data = parsed.data;

    const analysis = analyzeProse(data.text);

    const issues: Array<{
      severity: "info" | "warn" | "error";
      category:
        | "coherence"
        | "clarity"
        | "continuity"
        | "marketability"
        | "style_alignment"
        | "filler"
        | "rhythm"
        | "dialogue";
      message: string;
    }> = [];

    const m = analysis.metrics;

    if (m.word_count > 0 && m.avg_sentence_words > 30) {
      issues.push({ severity: "warn", category: "rhythm", message: "Sentences run long; tighten and vary cadence" });
    }

    if (m.filler_phrase_count > 0) {
      issues.push({
        severity: "warn",
        category: "filler",
        message: "Filler detected; cut throat-clearing and replace generic reactions with specific action"
      });
    }

    if (m.vague_word_count > 0) {
      issues.push({
        severity: "warn",
        category: "clarity",
        message: "Abstract/vague language detected; replace with concrete behavior and specific detail"
      });
    }

    const adverbThreshold = Math.max(3, Math.floor(m.word_count / 250));
    if (m.adverb_like_count > adverbThreshold) {
      issues.push({
        severity: "info",
        category: "clarity",
        message: "Adverb density may be high; consider stronger verbs and cleaner clauses"
      });
    }

    const report = {
      schema_version: data.schema_version,
      metrics: analysis.metrics,
      issues,
      meta: {
        directive_name: (data as any).directive_name ?? null,
        style_profile_name: (data as any).style_profile_name ?? DEFAULT_STYLE_PROFILE_NAME
      }
    };

    return upsertArtifact({
      projectId,
      type: "quality_report",
      name: "latest",
      schemaVersion: report.schema_version,
      payload: report
    });
  });

  // Deterministic de-AI edit report (and optional conservative auto-clean)
  const DeAiEditsRequestSchema = z.object({
    schema_version: z.number().int().min(1),
    text: z.string().min(1).max(200000),
    apply: z.boolean().optional()
  });

  app.post("/v1/edits/deai", async (req) => {
    const projectId = await getOrCreateDefaultProjectId();

    const parsed = DeAiEditsRequestSchema.safeParse(req.body);
    if (!parsed.success) badRequest("Invalid de-AI edit request");
    const data = parsed.data;

    const report = generateDeAiReport(data.text);

    let cleaned_text: string | null = null;
    let applied_ops: DeAiEditOp[] = [];

    if (data.apply === true) {
      const applied = applySafeDeAiOps(data.text, report.suggested_ops);
      cleaned_text = applied.text;
      applied_ops = applied.applied;
    }

    const response = {
      schema_version: 1 as const,
      counts: report.counts,
      flags: report.flags,
      applied_ops,
      cleaned_text
    };

    await upsertArtifact({
      projectId,
      type: "quality_report",
      name: "deai_latest",
      schemaVersion: 1,
      payload: response
    });

    return response;
  });

  // -------------------------
  // Optional multi-project routes
  // -------------------------

  app.post("/v1/projects", async (req) => {
    const parsed = ProjectCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) badRequest("Invalid project request");
    const data = parsed.data;

    const created = await prisma.project.create({
      data: { name: data.name ?? null }
    });

    return { project_id: created.id };
  });

  app.get("/v1/projects", async () => {
    const projects = await prisma.project.findMany({ orderBy: { updatedAt: "desc" } });
    return {
      projects: projects.map((p) => ({
        project_id: p.id,
        name: p.name,
        created_at: p.createdAt,
        updated_at: p.updatedAt
      }))
    };
  });
}
