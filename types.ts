export type ArtifactType =
  | "style_profile"
  | "character_sheet"
  | "draft_directive"
  | "revision_plan"
  | "quality_report"
  | "freeform_note";

export type Tense = "past" | "present";

export type Deliverable =
  | "scene"
  | "chapter"
  | "cold_open"
  | "synopsis"
  | "pitch"
  | "query_letter"
  | "outline";

export type Severity = "info" | "warn" | "error";

export type IssueCategory =
  | "coherence"
  | "clarity"
  | "continuity"
  | "marketability"
  | "style_alignment"
  | "filler"
  | "rhythm"
  | "dialogue";
