import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";

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
 *
 * Goal: grounded, clear, concise, active, no "writerly fog", no cliché.
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
      "Paragraphs are action units. Break on a turn: decision, reveal, escalation, or consequence. No static paragraphs."
  },
  diction: {
    register:
      "Plainspoken, precise, concrete. Use simple language whenever possible. Avoid inflated literary phrasing.",
    concreteness_bias:
      "Write what can be seen, heard, touched, done, decided. Replace abstract labels with observable behavior and specific objects.",
    verb_energy:
      "Active voice by default. Strong verbs over adverbs. Make motion, intent, and cause-and-effect obvious.",
    adjective_policy:
      "Minimal modifiers. Use one precise adjective only when it changes meaning. If it’s decorative, cut it."
  },
  imagery_and_metaphor: {
    purpose:
      "Metaphor is allowed only if it clarifies emotion, power dynamics, or sensory reality. Never decorative.",
    when_used:
      "Use metaphor only at turning points (realization, escalation, reversal) and keep it brief and grounded.",
    how_used:
      "Concrete, physical, anchored to the POV character’s lived world. No cosmic abstraction. If it can’t be stated literally, it doesn’t belong.",
    metaphor_budget:
      "Default 0 metaphors per paragraph. If used, max 1, and it must earn its place by increasing clarity or tension.",
    disallowed: [
      "cliché metaphors",
      "cosmic/generalized abstraction (universe, abyss, eternity, void, darkness-as-mood)",
      "dreamlike/fog/shattered/whispered-into-the-night phrasing",
      "metaphor that does not translate cleanly into literal meaning"
    ]
  },
  constraints: {
    must_avoid: [
      "clichés",
      "throat-clearing and filler",
      "generic emotion labels without behavior",
      "passive voice unless the agent is unknown/hidden on purpose",
      "abstract commentary that does not affect action or choice",
      "symmetrical AI cadence and over-balanced sentences",
      "decorative metaphor"
    ],
    must_include: [
      "show-dont-tell via behavior + concrete detail + consequence",
      "active verbs and clear agents",
      "every sentence does work (action, tension, character, necessary info, or change)",
      "cause-and-effect clarity",
      "only relevant detail (no neutral description)"
    ],
    rating_boundaries:
      "Follow user boundaries. Default: grounded adult themes allowed; avoid explicit sexual content unless the user explicitly requests it."
  }
} as const;

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
    where: {
      projectId,
      type: "style_profile",
      name: DEFAULT_STYLE_PROFILE_NAME
    },
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
    // Race on first boot (two requests at once). Safe to ignore.
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
    const body = parsedBody.success ? parsedBody.data : badRequest("Invalid artifact upsert body");

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
    const { type, name, revision } = req.params as {
      type: string;
      name: string;
      revision: string;
    };

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
    const data = parsed.success ? parsed.data : badRequest("Invalid style profile");

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
    const data = parsed.success ? parsed.data : badRequest("Invalid character sheet");

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
    const data = parsed.success ? parsed.data : badRequest("Invalid draft directive");

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
    const reqData = parsed.success ? parsed.data : badRequest("Invalid revision plan request");

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
        "Cliché phrasing"
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
    const data = parsed.success ? parsed.data : badRequest("Invalid diagnostic request");

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
      issues.push({
        severity: "warn",
        category: "rhythm",
        message: "Sentences run long; tighten and vary cadence"
      });
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

  // -------------------------
  // Optional multi-project routes (keep these)
  // -------------------------

  app.post("/v1/projects", async (req) => {
    const parsed = ProjectCreateSchema.safeParse(req.body ?? {});
    const data = parsed.success ? parsed.data : badRequest("Invalid project request");

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
