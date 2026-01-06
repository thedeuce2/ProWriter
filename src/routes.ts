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
 * This is not "example" text — it's the default operating style for ProWriter.
 * It gets seeded once into the DB so the GPT can always reference it.
 */
const DEFAULT_STYLE_PROFILE = {
  schema_version: 1,
  label: "ProWriter Default (clarity + purpose-first)",
  influences: [],
  rhythm: {
    sentence_length_bias:
      "Bias toward short/medium sentences; use a longer sentence only when it increases tension or reveals a thought-turn.",
    punctuation_habits:
      "Prefer clean punctuation. Avoid em-dash chains and rhetorical fragments unless voice demands it.",
    paragraphing: "Paragraphs are action units. Break on a turn: decision, reveal, power shift, sensory interrupt."
  },
  diction: {
    register: "Natural, contemporary, concrete. No pseudo-literary inflation.",
    concreteness_bias: "Prefer observable behavior and specific objects over abstract labels.",
    verb_energy: "Strong verbs over adverbs. Make motion legible.",
    adjective_policy: "One precise modifier beats three decorative ones."
  },
  imagery_and_metaphor: {
    purpose: "Metaphor is allowed only to clarify emotion, power dynamics, or sensory reality—not to decorate.",
    when_used: "Use metaphor at turning points: realization, escalation, reversal, controlled breath after impact.",
    how_used: "Brief, concrete, anchored to POV character’s world. No cosmic abstraction.",
    metaphor_budget: "Max 1 metaphor per paragraph, and it must earn its place.",
    disallowed: ["cosmic abstraction", "vague existential fog", "meaningless 'like a dream' phrasing", "random body-poetry"]
  },
  description_strategy: {
    focus: "Describe what matters to the scene objective: threat, desire, leverage, evidence, escape routes.",
    omissions: "Skip neutral detail unless it raises tension or reveals character.",
    pacing: "If tension rises, compress description into sharp specifics. If tension drops, the writing must still change something."
  },
  theme_handling: {
    approach: "Let themes emerge through choices, consequences, and repeated pressures—not speeches.",
    recurrence_signals: "Use recurring objects, behaviors, and dilemmas rather than repeated statements."
  },
  pov_behavior: {
    distance: "Close enough to feel thought; far enough to keep action clean.",
    interiority: "Interiority must create a choice, a lie, or a contradiction—not commentary.",
    reliability: "If unreliable, show bias via selective detail rather than confusion."
  },
  dialogue_behavior: {
    subtext_rules: "Dialogue must have leverage. People avoid saying the real thing unless cornered.",
    escalation_patterns: "Each exchange changes power: concession, threat, reveal, trap.",
    exposition_hiding: "Hide exposition inside conflict: accusation, bargaining, misdirection, insult, confession."
  },
  constraints: {
    must_avoid: ["filler reactions", "generic emotion labels without behavior", "metaphors that don't clarify", "AI-sounding symmetry"],
    must_include: ["specific actions", "cause-and-effect clarity", "a turn per paragraph or per beat"],
    rating_boundaries: "Follow user boundaries. Default: adult themes allowed, no explicit sexual content unless user requests."
  },
  application_rules: [
    {
      why: "Readers trust scenes that track physical reality and intent.",
      when: "At the start of each paragraph and each dialogue exchange.",
      how: "State who does what, what changes, and what it means for the objective."
    },
    {
      why: "Marketable prose is clear, tense, and selective.",
      when: "Anytime a passage feels writerly or indulgent.",
      how: "Cut the pretty sentence unless it increases tension, reveals character, or sharpens meaning."
    }
  ]
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
    // In case of a race on first boot (two requests at once), ignore.
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
      "Preserve meaning and intent unless explicitly told to change it",
      "Maintain continuity and avoid inventing new facts",
      "Prefer concrete verbs and observable behavior over vague abstraction",
      "Ensure cause-and-effect is clear at the paragraph level",
      "Remove filler phrases and avoid decorative metaphor that does not clarify"
    ];

    const modeRubric: Record<string, string[]> = {
      humanize: [
        "Increase specificity of human behavior and subtext without melodrama",
        "Replace generic reactions with character-specific reactions",
        "Keep voice consistent and avoid robotic symmetry"
      ],
      marketability: [
        "Tighten openings and transitions; reduce throat-clearing",
        "Sharpen stakes and objective; make tension legible early",
        "Favor clarity and pacing over ornamental language"
      ],
      tighten: [
        "Remove redundancy and tighten sentences without losing voice",
        "Prefer one strong image over multiple weaker images",
        "Avoid over-explaining what the reader can infer"
      ],
      voice_match: [
        "Align diction and rhythm to the chosen style constraints",
        "Keep metaphor budget controlled and purposeful",
        "Avoid imitation-by-copy; apply techniques, not wording"
      ],
      clarity: [
        "Disambiguate pronouns and causal links",
        "Ground setting and action so the reader can visualize sequence",
        "Reduce abstract nouns in favor of concrete actions"
      ],
      dialogue_punchup: [
        "Make dialogue do work: subtext, leverage, concealment, escalation",
        "Avoid on-the-nose exposition",
        "Track who has power in each exchange"
      ],
      pacing: [
        "Compress low-tension passages and expand high-tension turns",
        "Turn summaries into scene beats when tension depends on it",
        "End on a change: decision, revelation, reversal, or escalation"
      ]
    };

    const planCandidate = {
      schema_version: reqData.schema_version,
      mode,
      rubric: [...rubricBase, ...(modeRubric[mode] ?? [])],
      risks_to_avoid: [
        "Vague sensory filler",
        "Unmotivated emotional swings",
        "Metaphor that does not clarify action, feeling, or power dynamics",
        "Continuity contradictions"
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
        message: "Average sentence length is high; consider tightening or varying cadence"
      });
    }

    if (m.filler_phrase_count > 0) {
      issues.push({
        severity: "warn",
        category: "filler",
        message: "Detected common filler phrases; replace with character-specific action or omission"
      });
    }

    if (m.vague_word_count > 0) {
      issues.push({
        severity: "warn",
        category: "clarity",
        message: "Detected vague language; increase specificity and observable behavior"
      });
    }

    const adverbThreshold = Math.max(3, Math.floor(m.word_count / 250));
    if (m.adverb_like_count > adverbThreshold) {
      issues.push({
        severity: "info",
        category: "clarity",
        message: "Adverb density may be high; consider replacing with stronger verbs"
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
