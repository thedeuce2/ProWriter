import { prisma } from "./prisma.js";
import { validateArtifactPayload } from "./validation.js";
import type { ArtifactType } from "./types.js";

export async function ensureProject(projectId: string) {
  const proj = await prisma.project.findUnique({ where: { id: projectId } });
  if (!proj) {
    const err = new Error("Project not found");
    // @ts-expect-error fastify will read statusCode
    err.statusCode = 404;
    throw err;
  }
  return proj;
}

export async function upsertArtifact(params: {
  projectId: string;
  type: ArtifactType;
  name: string;
  schemaVersion: number;
  payload: unknown;
}) {
  await ensureProject(params.projectId);

  const validated = validateArtifactPayload(params.type, params.payload);

  const existing = await prisma.artifact.findUnique({
    where: {
      projectId_type_name: {
        projectId: params.projectId,
        type: params.type,
        name: params.name
      }
    },
    include: { revisions: { orderBy: { revisionNumber: "desc" }, take: 1 } }
  });

  if (!existing) {
    return prisma.$transaction(async (tx) => {
      const artifact = await tx.artifact.create({
        data: {
          projectId: params.projectId,
          type: params.type,
          name: params.name,
          schemaVersion: params.schemaVersion
        }
      });

      const rev = await tx.artifactRevision.create({
        data: {
          artifactId: artifact.id,
          revisionNumber: 1,
          payload: validated as any
        }
      });

      await tx.artifact.update({
        where: { id: artifact.id },
        data: { currentRevisionId: rev.id }
      });

      return {
        artifact_id: artifact.id,
        type: artifact.type,
        name: artifact.name,
        schema_version: artifact.schemaVersion,
        revision: 1
      };
    });
  }

  const lastRev = existing.revisions[0]?.revisionNumber ?? 0;

  return prisma.$transaction(async (tx) => {
    const nextRevision = lastRev + 1;

    const rev = await tx.artifactRevision.create({
      data: {
        artifactId: existing.id,
        revisionNumber: nextRevision,
        payload: validated as any
      }
    });

    await tx.artifact.update({
      where: { id: existing.id },
      data: {
        schemaVersion: params.schemaVersion,
        currentRevisionId: rev.id
      }
    });

    return {
      artifact_id: existing.id,
      type: existing.type,
      name: existing.name,
      schema_version: params.schemaVersion,
      revision: nextRevision
    };
  });
}

export async function getArtifactLatest(params: {
  projectId: string;
  type: ArtifactType;
  name: string;
}) {
  await ensureProject(params.projectId);

  const artifact = await prisma.artifact.findUnique({
    where: {
      projectId_type_name: {
        projectId: params.projectId,
        type: params.type,
        name: params.name
      }
    }
  });

  if (!artifact || !artifact.currentRevisionId) return null;

  const rev = await prisma.artifactRevision.findUnique({
    where: { id: artifact.currentRevisionId }
  });

  if (!rev) return null;

  return {
    artifact_id: artifact.id,
    type: artifact.type,
    name: artifact.name,
    schema_version: artifact.schemaVersion,
    revision: rev.revisionNumber,
    payload: rev.payload
  };
}

export async function listArtifacts(projectId: string, type?: ArtifactType) {
  await ensureProject(projectId);

  const artifacts = await prisma.artifact.findMany({
    where: { projectId, ...(type ? { type } : {}) },
    orderBy: [{ type: "asc" }, { name: "asc" }]
  });

  return artifacts.map((a) => ({
    artifact_id: a.id,
    type: a.type,
    name: a.name,
    schema_version: a.schemaVersion,
    created_at: a.createdAt,
    updated_at: a.updatedAt
  }));
}

export async function listArtifactRevisions(params: {
  projectId: string;
  type: ArtifactType;
  name: string;
}) {
  await ensureProject(params.projectId);

  const artifact = await prisma.artifact.findUnique({
    where: {
      projectId_type_name: {
        projectId: params.projectId,
        type: params.type,
        name: params.name
      }
    }
  });

  if (!artifact) return null;

  const revisions = await prisma.artifactRevision.findMany({
    where: { artifactId: artifact.id },
    orderBy: { revisionNumber: "asc" }
  });

  return revisions.map((r) => ({
    revision: r.revisionNumber,
    created_at: r.createdAt
  }));
}

export async function getArtifactRevision(params: {
  projectId: string;
  type: ArtifactType;
  name: string;
  revision: number;
}) {
  await ensureProject(params.projectId);

  const artifact = await prisma.artifact.findUnique({
    where: {
      projectId_type_name: {
        projectId: params.projectId,
        type: params.type,
        name: params.name
      }
    }
  });

  if (!artifact) return null;

  const rev = await prisma.artifactRevision.findUnique({
    where: { artifactId_revisionNumber: { artifactId: artifact.id, revisionNumber: params.revision } }
  });

  if (!rev) return null;

  return {
    artifact_id: artifact.id,
    type: artifact.type,
    name: artifact.name,
    schema_version: artifact.schemaVersion,
    revision: rev.revisionNumber,
    payload: rev.payload
  };
}
