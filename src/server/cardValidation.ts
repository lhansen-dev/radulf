import { EPIC_RUN_MODES, type EpicRunMode } from "@/db";
import type { BreakdownPiece } from "./epics";
import type { CreateCardRequest } from "@/shared/cardRequests";
import {
  invalid,
  optionalInteger,
  optionalString,
  record,
  rejectUnknownKeys,
  requiredString,
} from "./requestValidation";

type CreateCardInput = Omit<
  CreateCardRequest,
  "maxIterations" | "timeoutMinutes" | "plannerModel" | "loopModel" | "evaluatorModel"
> & {
  maxIterations: number | null;
  timeoutMinutes: number | null;
  plannerModel: string | null;
  loopModel: string | null;
  evaluatorModel: string | null;
  /** Spec 30: per-card plan critic override; null/undefined defers to settings. */
  planCritic?: boolean | null;
  criticModel?: string | null;
};

export type UpdateCardInput = {
  title?: string;
  description?: string;
  maxIterations?: number | null;
  timeoutMinutes?: number | null;
  position?: number;
  plannerModel?: string | null;
  loopModel?: string | null;
  evaluatorModel?: string | null;
  /** Spec 30: null clears the override; otherwise stored as SQLite's 0/1. */
  planCritic?: number | null;
  criticModel?: string | null;
  /** Stored as SQLite's 0/1, so the PATCH route can spread these straight in. */
  grillMe?: number;
  scopingAuthorsPlan?: number;
  /** Spec 24: how an epic's pieces are scheduled. */
  runMode?: EpicRunMode | null;
};

const CREATE_FIELDS = new Set([
  "repoId", "title", "description", "maxIterations", "timeoutMinutes", "plannerModel",
  "loopModel", "evaluatorModel", "reviewPlanBeforeImplementation", "autoApprove", "openPr",
  "grillMe", "scopingAuthorsPlan", "baseBranch", "planCritic", "criticModel",
]);

/** The create body's boolean flags, all optional and all defaulting to false. */
const CREATE_BOOLEANS = [
  "reviewPlanBeforeImplementation", "autoApprove", "openPr", "grillMe", "scopingAuthorsPlan",
] as const;

export function parseCreateCard(value: unknown): CreateCardInput {
  const body = record(value, "card body");
  rejectUnknownKeys(body, CREATE_FIELDS, "card field");
  if (body.description !== undefined && typeof body.description !== "string") {
    invalid("description must be a string");
  }
  for (const field of CREATE_BOOLEANS) {
    if (body[field] !== undefined && typeof body[field] !== "boolean") invalid(`${field} must be a boolean`);
  }
  if (body.planCritic != null && typeof body.planCritic !== "boolean") {
    invalid("planCritic must be a boolean or null");
  }
  return {
    repoId: requiredString(body.repoId, "repoId"),
    title: requiredString(body.title, "title"),
    description: body.description ?? "",
    maxIterations: optionalInteger(body.maxIterations, "maxIterations", 1_000),
    timeoutMinutes: optionalInteger(body.timeoutMinutes, "timeoutMinutes", 10_080),
    plannerModel: optionalString(body.plannerModel, "plannerModel"),
    loopModel: optionalString(body.loopModel, "loopModel"),
    evaluatorModel: optionalString(body.evaluatorModel, "evaluatorModel"),
    reviewPlanBeforeImplementation: body.reviewPlanBeforeImplementation ?? false,
    autoApprove: body.autoApprove ?? false,
    openPr: body.openPr ?? false,
    grillMe: body.grillMe ?? false,
    scopingAuthorsPlan: body.scopingAuthorsPlan ?? false,
    baseBranch: optionalString(body.baseBranch, "baseBranch"),
    planCritic: body.planCritic === undefined ? undefined : (body.planCritic as boolean | null),
    criticModel: optionalString(body.criticModel, "criticModel"),
  } as CreateCardInput;
}

const UPDATE_FIELDS = new Set([
  "title", "description", "maxIterations", "timeoutMinutes", "position", "plannerModel", "loopModel",
  "evaluatorModel", "grillMe", "scopingAuthorsPlan", "runMode", "planCritic", "criticModel",
]);

function runMode(value: unknown): EpicRunMode {
  if (!EPIC_RUN_MODES.includes(value as EpicRunMode)) invalid("runMode must be ordered or parallel");
  return value as EpicRunMode;
}

export function parseUpdateCard(value: unknown): UpdateCardInput {
  const body = record(value, "card body");
  rejectUnknownKeys(body, UPDATE_FIELDS, "card field");
  const patch: UpdateCardInput = {};
  if ("title" in body) patch.title = requiredString(body.title, "title");
  if ("description" in body) {
    if (typeof body.description !== "string") invalid("description must be a string");
    patch.description = body.description;
  }
  if ("maxIterations" in body) {
    patch.maxIterations = optionalInteger(body.maxIterations, "maxIterations", 1_000);
  }
  if ("timeoutMinutes" in body) {
    patch.timeoutMinutes = optionalInteger(body.timeoutMinutes, "timeoutMinutes", 10_080);
  }
  if ("position" in body) {
    if (typeof body.position !== "number" || !Number.isFinite(body.position)) {
      invalid("position must be a finite number");
    }
    patch.position = body.position;
  }
  for (const field of ["plannerModel", "loopModel", "evaluatorModel", "criticModel"] as const) {
    if (field in body) patch[field] = optionalString(body[field], field);
  }
  if ("planCritic" in body) {
    if (body.planCritic === null) patch.planCritic = null;
    else if (typeof body.planCritic === "boolean") patch.planCritic = body.planCritic ? 1 : 0;
    else invalid("planCritic must be a boolean or null");
  }
  for (const field of ["grillMe", "scopingAuthorsPlan"] as const) {
    if (!(field in body)) continue;
    if (typeof body[field] !== "boolean") invalid(`${field} must be a boolean`);
    patch[field] = body[field] ? 1 : 0;
  }
  if ("runMode" in body) patch.runMode = body.runMode === null ? null : runMode(body.runMode);
  if (Object.keys(patch).length === 0) invalid("nothing to update");
  return patch;
}

const BREAKDOWN_FIELDS = new Set(["pieces", "runMode"]);
const PIECE_FIELDS = new Set(["title", "description", "repoId"]);

/** Spec 24: the body of POST /api/cards/:id/breakdown. The run mode defaults
 * to in order, as the split proposal's parser does. */
export function parseBreakdown(value: unknown): { pieces: BreakdownPiece[]; runMode: EpicRunMode } {
  const body = record(value, "breakdown body");
  rejectUnknownKeys(body, BREAKDOWN_FIELDS, "breakdown field");
  if (!Array.isArray(body.pieces)) invalid("pieces must be an array");
  const pieces = (body.pieces as unknown[]).map((item) => {
    const piece = record(item, "breakdown piece");
    rejectUnknownKeys(piece, PIECE_FIELDS, "piece field");
    if (typeof piece.description !== "string") invalid("every piece needs a description");
    return {
      title: requiredString(piece.title, "title"),
      description: piece.description as string,
      repoId: optionalString(piece.repoId, "repoId"),
    };
  });
  return { pieces, runMode: body.runMode === undefined ? "ordered" : runMode(body.runMode) };
}
