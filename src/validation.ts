import { z } from "zod";

const ARTIFACT_TYPES = [
  "style_profile",
  "character_sheet",
  "draft_directive",
  "revision_plan",
  "quality_report",
  "freeform_note"
] as const;

const DELIVERABLES = [
  "scene",
  "chapter",
  "cold_open",
  "synopsis",
  "pitch",
  "query_letter",
  "outline"
] as const;

const TENSES = ["past", "present"] as const;
const SEVERITIES = ["info", "warn", "error"] as const;

const ISSUE_CATEGORIES = [
  "coherence",
  "clarity",
  "continuity",
  "marketability",
  "style_alignment",
  "filler",
  "rhythm",
  "dialogue"
] as const;

export const ArtifactTypeSchema = z.enum(ARTIFACT_TYPES);
export const DeliverableSchema = z.enum(DELIVERABLES);
export const TenseSchema = z.enum(TENSES);
export const SeveritySchema = z.enum(SEVERITIES);
export const IssueCategorySchema = z.enum(ISSUE_CATEGORIES);

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
  rhythm: z
    .object({
      sentence_length_bias: z.string().min(1).max(500).optional(),
      punctuation_habits: z.string().min(1).max(1000).optional(),
      paragraphing: z.string().min(1).max(1000).optional()
    })
    .optional(),
  diction: z
    .object({
      register: z.string().min(1).max(500).optional(),
      concreteness_bias: z.string().min(1).max(500).optional(),
      verb_energy: z.string().min(1).max(500).optional(),
      adjective_policy: z.string().min(1).max(500).optional()
    })
    .optional(),
  imagery_and_metaphor: z
    .object({
      purpose: z.string().min(1).max(1500).optional(),
      when_used: z.string().min(1).max(1500).optional(),
      how_used: z.string().min(1).max(1500).optional(),
      metaphor_budget: z.string().min(1).max(500).optional(),
      disallowed: z.array(z.string().min(1).max(200)).optional()
    })
    .optional(),
  description_strategy: z
    .object({
      focus: z.string().min(1).max(1500).optional(),
      omissions: z.string().min(1).max(1500).optional(),
      pacing: z.string().min(1).max(1500).optional()
    })
    .optional(),
  theme_handling: z
    .object({
      approach: z.string().min(1).max(1500).optional(),
      recurrence_signals: z.string().min(1).max(1500).optional()
    })
    .optional(),
  pov_behavior: z
    .object({
      distance: z.string().min(1).max(1000).optional(),
      interiority: z.string().min(1).max(1000).optional(),
      reliability: z.string().min(1).max(1000).optional()
    })
    .optional(),
  dialogue_behavior: z
    .object({
      subtext_rules: z.string().min(1).max(1500).optional(),
      escalation_patterns: z.string().min(1).max(1500).optional(),
      exposition_hiding: z.string().min(1)._
