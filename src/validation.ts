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
    if (!parsed.success) badRequest("Invalid project request");

    const created = await prisma.project.create({
      data: { name: parsed.data.name ?? null }
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

    const style_profiles = artifacts
      .filter((a) => a.type === "style_profile")
      .map((a) => a.name);

    const characters = artifacts
      .filter((a) => a.type === "character_sheet")
      .map((a) => a.name);

    const draft_directives = artifacts
      .filter((a) => a.type === "draft_directive")
      .map((a) => a.name);

    return {
      project_id: projectId,
      style_profiles,
      characters,
      draft_directives
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
      projectId: strin
