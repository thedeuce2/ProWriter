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

export async function registerRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({ ok: true }));

  app.get("/openapi.yaml", async (_req, reply) => {
    const p = path.join(process.cwd(), "openapi.yaml");
    const yml = fs.readFileSync(p, "utf8");
    reply.type("text/yaml").send(yml);
  });

  // Projects
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

  // Canon digest (lightweight, deterministic)
  app.get("/v1/projects/:projectId/canon-digest", async (req) => {
    const { projectId } = req.params as { projectId: string };

    const artifacts = await listArtifacts(projectId);

    return {
      project_id: projectId,
      style_profiles: artifacts.filter((a) => a.type === "style_profile").map((a) => a.name),
      characters: artifacts.filter((a) => a.type === "character_sheet").map((a) => a.name),
      draft_directives: artifacts.filter((a) => a.type === "draft_directive").map((a) => a.name)
    };
  });

  // Generic artifact endpoints
  app.get("/v1/projects/:projectId/artifacts", async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = req.query as { type?: string };

    const type = q.type ? asArtifactType(q.type) : undefined;
    return { artifacts: await listArtifacts(projectId, type) };
  });

  app.put("/v1/projects/:projectId/artifacts/:type/:name", async (req) => {
    const { projectId, type, name } = req.params as {
      projectId: string;
      type: string;
      name: string;
    };

    const artifactType = asArtifactType(type);

    const parsedBody = ArtifactUpsertSchema.safeParse(req.body);
    const body = parsedBody.success ? parsedBody.data : badRequest("Invalid artifact upsert body");

    const result = await upsertArtifact({
      projectId,
      type: artifactType,
      name,
      schemaVersion: body.schema_version,
      payload: body.payload
    });

    return result;
  });

  app.get("/v1/projects/:projectId/artifacts/:type/:name", async (req) => {
    const { projectId, type, name } = req.params as {
      projectId: string;
      type: string;
      name: string;
    };

    const artifactType = asArtifactType(type);

    const latest = await getArtifactLatest({ projectId, type: artifactType, name });
    if (!latest) return { error: "not_found" };
    return latest;
  });

  app.get("/v1/projects/:projectId/artifacts/:type/:name/revisions", async (req) => {
    const { projectId, type, name } = req.params as {
      projectId: string;
      type: string;
      name: string;
    };

    const artifactType = asArtifactType(type);

    const list = await listArtifactRevisions({ projectId, type: artifactType, name });
    if (!list) return { error: "not_found" };
    return { revisions: list };
  });

  app.get("/v1/projects/:projectId/artifacts/:type/:name/revisions/:revision", async (req) => {
    const { projectId, type, name, revision } = req.params as {
      projectId: string;
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

  // Typed convenience endpoints (stable operationIds for Actions)

  app.put("/v1/projects/:projectId/style-profiles/:name", async (req) => {
    const { projectId, name } = req.params as { projectId: string; name: string };

    const parsed = StyleProfileSchema.safeParse(req.body);
    const data = parsed.success ? parsed.data : badRequest("Invalid style profile");

    return upsertArtifact({
      projectId,
      type: "style_profile",
      name,
      schemaVersion: data.schema_version,
      payload: data
    });
  });

  app.get("/v1/projects/:projectId/style-profiles/:name", async (req) => {
    const { projectId, name } = req.params as { projectId: string; name: string };
    const latest = await getArtifactLatest({ projectId, type: "style_profile", name });
    if (!latest) return { error: "not_found" };
    return latest;
  });

  app.put("/v1/projects/:projectId/character-sheets/:name", async (req) => {
    const { projectId, name } = req.params as { projectId: string; name: string };

    const parsed = CharacterSheetSchema.safeParse(req.body);
    const data = parsed.success ? parsed.data : badRequest("Invalid character sheet");

    return upsertArtifact({
      projectId,
      type: "character_sheet",
      name,
      schemaVersion: data.schema_version,
      payload: data
    });
  });

  app.get("/v1/projects/:projectId/character-sheets/:name", async (req) => {
    const { projectId, name } = req.params as { projectId: string; name: string };
    const latest = await getArtifactLatest({ projectId, type: "character_sheet", name });
    if (!latest) return { error: "not_found" };
    return latest;
  });

  app.post("/v1/projects/:projectId/draft-directives", async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = req.query as { name?: string };

    const directiveName =
      q.name && typeof q.name === "string" && q.name.trim().length > 0 ? q.name : "current";

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

  app.post("/v1/projects/:projectId/revision-plans", async (req) => {
    const { projectId } = req.params as { projectId: string };
    const q = req.query as { name?: string };

    const planName =
      q.name && typeof q.name === "string" && q.name.trim().length > 0 ? q.name : "current";

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
      recommended_passes: [
        "Continuity pass",
        "Clarity pass",
        "Pacing pass",
        "Line-level tightening pass"
      ]
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

  app.post("/v1/projects/:projectId/diagnostics/prose", async (req) => {
    const { projectId } = req.params as { projectId: string };

    const parsed = ProseDiagnosticRequestSchema.safeParse(req.body);
    const data = parsed.success ? parsed.data : badRequest("Invalid diagnostic request");

    const { text, directive_name, style_profile_name } = data;

    const directive = directive_name
      ? await getArtifactLatest({ projectId, type: "draft_directive", name: directive_name })
      : null;

    const style = style_profile_name
      ? await getArtifactLatest({ projectId, type: "style_profile", name: style_profile_name })
      : null;

    const analysis = analyzeProse(text);

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

    if (directive && directive.payload && typeof directive.payload === "object") {
      issues.push({
        severity: "info",
        category: "style_alignment",
        message:
          "Directive referenced; ensure draft satisfies objective, conflict, stakes, and beat order"
      });
    }

    if (style && style.payload && typeof style.payload === "object") {
      issues.push({
        severity: "info",
        category: "style_alignment",
        message: "Style profile referenced; apply technique rules without copying wording"
      });
    }

    const report = {
      schema_version: data.schema_version,
      metrics: analysis.metrics,
      issues
    };

    return upsertArtifact({
      projectId,
      type: "quality_report",
      name: "latest",
      schemaVersion: report.schema_version,
      payload: report
    });
  });

  app.setErrorHandler((error, _req, reply) => {
    const status = (error as any).statusCode ?? 500;
    reply.code(status).send({
      error: status === 500 ? "internal_error" : "bad_request"
    });
  });
}
