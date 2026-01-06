import { z } from "zod";
import type { ArtifactType, Deliverable, Severity, IssueCategory, Tense } from "./types.js";

export const ArtifactTypeSchema = z.enum([
  "style_profile",
  "character_sheet",
  "draft_directive",
  "revision_plan",
  "quality_report",
  "freeform_note"
] satisfies readonly ArtifactType[]);

export const DeliverableSchema = z.enum([
  "scene",
  "chapter",
  "cold_open",
  "synopsis",
  "pitch",
  "query_letter",
  "outline"
] satisfies readonly Deliverable[]);

export const TenseSchema = z.enum(["past", "present"] satisfies readonly Tense[]);

export const SeveritySchema = z.enum(["info", "warn", "error"] satisfies readonly Severity[]);

export const IssueCategorySchema = z.enum([
  "coherence",
  "clarity",
  "continuity",
  "marketability",
  "style_alignment",
  "filler",
  "rhythm",
  "dialogue"
] satisfies readonly IssueCategory[]);

export const ProjectCreateSchema = z.object({
  name: z.string().min(1).max(200).optional()
});

export const CharacterRelationshipSchema = z.object({
  other_name: z.string().min(1).max(200),
  relationship: z.string().min(1).max(500)
});

export const CharacterSheetSchema = z.object({
  schema_version: z.number().int().min(1),
  name: z.string().min(1).max(200),
  role_in_story: z.string().min(1).max(500).optional(),
  pronouns: z.string().min(1).max(50).optional(),
  age: z.number().int().min(0).max(130).optional(),
  physical: z.string().min(1).max(2000).optional(),
  voice: z.string().min(1).max(2000).optional(),
  background: z.string().min(1).max(4000).optional(),
  wants: z.array(z.string().min(1).max(500)).optional(),
  fears: z.array(z.string().min(1).max(500)).optional(),
  contradictions: z.array(z.string().min(1).max(500)).optional(),
  relationships: z.array(CharacterRelationshipSchema).optional(),
  notes: z.string().min(1).max(6000).optional()
});

export const StyleProfileSchema = z.object({
  schema_version: z.number().int().min(1),
  label: z.string().min(1).max(200),
  influences: z.array(z.string().min(1).max(200)).optional(),
  rhythm: z.object({
    sentence_length_bias: z.string().min(1).max(500).optional(),
    punctuation_habits: z.string().min(1).max(1000).optional(),
    paragraphing: z.string().min(1).max(1000).optional()
  }).optional(),
  diction: z.object({
    register: z.string().min(1).max(500).optional(),
    concreteness_bias: z.string().min(1).max(500).optional(),
    verb_energy: z.string().min(1).max(500).optional(),
    adjective_policy: z.string().min(1).max(500).optional()
  }).optional(),
  imagery_and_metaphor: z.object({
    purpose: z.string().min(1).max(1500).optional(),
    when_used: z.string().min(1).max(1500).optional(),
    how_used: z.string().min(1).max(1500).optional(),
    metaphor_budget: z.string().min(1).max(500).optional(),
    disallowed: z.array(z.string().min(1).max(200)).optional()
  }).optional(),
  description_strategy: z.object({
    focus: z.string().min(1).max(1500).optional(),
    omissions: z.string().min(1).max(1500).optional(),
    pacing: z.string().min(1).max(1500).optional()
  }).optional(),
  theme_handling: z.object({
    approach: z.string().min(1).max(1500).optional(),
    recurrence_signals: z.string().min(1).max(1500).optional()
  }).optional(),
  pov_behavior: z.object({
    distance: z.string().min(1).max(1000).optional(),
    interiority: z.string().min(1).max(1000).optional(),
    reliability: z.string().min(1).max(1000).optional()
  }).optional(),
  dialogue_behavior: z.object({
    subtext_rules: z.string().min(1).max(1500).optional(),
    escalation_patterns: z.string().min(1).max(1500).optional(),
    exposition_hiding: z.string().min(1).max(1500).optional()
  }).optional(),
  constraints: z.object({
    must_avoid: z.array(z.string().min(1).max(200)).optional(),
    must_include: z.array(z.string().min(1).max(200)).optional(),
    rating_boundaries: z.string().min(1).max(300).optional()
  }).optional(),
  application_rules: z.array(z.object({
    why: z.string().min(1).max(1200),
    when: z.string().min(1).max(1200),
    how: z.string().min(1).max(1200)
  })).optional()
});

export const BeatSchema = z.object({
  purpose: z.string().min(1).max(500),
  event: z.string().min(1).max(2000),
  outcome: z.string().min(1).max(1000).optional()
});

export const DraftDirectiveSchema = z.object({
  schema_version: z.number().int().min(1),
  deliverable: DeliverableSchema,
  pov: z.string().min(1).max(200),
  tense: TenseSchema,
  target_length_min: z.number().int().min(1).optional(),
  target_length_max: z.number().int().min(1).optional(),
  objective: z.string().min(1).max(1200),
  conflict: z.string().min(1).max(1200),
  stakes: z.string().min(1).max(1200),
  beats: z.array(BeatSchema).min(1),
  dialogue_intent: z.string().min(1).max(1200).optional(),
  style_constraints: z.array(z.string().min(1).max(400)).optional(),
  must_include: z.array(z.string().min(1).max(400)).optional(),
  must_avoid: z.array(z.string().min(1).max(400)).optional(),
  continuity_requirements: z.array(z.string().min(1).max(600)).optional()
});

export const RevisionModeSchema = z.enum([
  "humanize",
  "marketability",
  "tighten",
  "voice_match",
  "clarity",
  "dialogue_punchup",
  "pacing"
]);

export const RevisionPlanRequestSchema = z.object({
  schema_version: z.number().int().min(1),
  mode: RevisionModeSchema,
  constraints: z.array(z.string().min(1).max(400)).optional(),
  target_audience: z.string().min(1).max(200).optional(),
  tone: z.string().min(1).max(200).optional(),
  pov: z.string().min(1).max(200).optional(),
  rating_boundaries: z.string().min(1).max(300).optional()
});

export const RevisionPlanSchema = z.object({
  schema_version: z.number().int().min(1),
  mode: RevisionModeSchema,
  rubric: z.array(z.string().min(1).max(600)).min(1),
  risks_to_avoid: z.array(z.string().min(1).max(400)).optional(),
  recommended_passes: z.array(z.string().min(1).max(400)).optional()
});

export const ProseDiagnosticRequestSchema = z.object({
  schema_version: z.number().int().min(1),
  text: z.string().min(1).max(200000),
  directive_name: z.string().min(1).max(200).optional(),
  style_profile_name: z.string().min(1).max(200).optional()
});

export const QualityIssueSchema = z.object({
  severity: SeveritySchema,
  category: IssueCategorySchema,
  message: z.string().min(1).max(1200)
});

export const QualityReportSchema = z.object({
  schema_version: z.number().int().min(1),
  metrics: z.object({
    word_count: z.number().int().min(0),
    sentence_count: z.number().int().min(0),
    avg_sentence_words: z.number().min(0),
    adverb_like_count: z.number().int().min(0),
    vague_word_count: z.number().int().min(0),
    filler_phrase_count: z.number().int().min(0),
    metaphor_marker_count: z.number().int().min(0),
    dialogue_ratio: z.number().min(0).max(1),
    readability_flesch: z.number().optional()
  }),
  issues: z.array(QualityIssueSchema)
});

export const ArtifactUpsertSchema = z.object({
  schema_version: z.number().int().min(1),
  payload: z.unknown()
});

export function validateArtifactPayload(type: string, payload: unknown) {
  if (type === "style_profile") return StyleProfileSchema.parse(payload);
  if (type === "character_sheet") return CharacterSheetSchema.parse(payload);
  if (type === "draft_directive") return DraftDirectiveSchema.parse(payload);
  if (type === "revision_plan") return RevisionPlanSchema.parse(payload);
  if (type === "quality_report") return QualityReportSchema.parse(payload);
  if (type === "freeform_note") return z.object({ schema_version: z.number().int().min(1) }).passthrough().parse(payload);
  throw new Error("Unknown artifact type");
}
