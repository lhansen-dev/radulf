export type CreateCardRequest = {
  repoId: string;
  title: string;
  description: string;
  plannerModel: string;
  loopModel: string;
  evaluatorModel: string;
  maxIterations: string | number;
  timeoutMinutes: string | number;
  reviewPlanBeforeImplementation: boolean;
  grillMe: boolean;
  scopingAuthorsPlan: boolean;
  autoApprove: boolean;
  openPr: boolean;
  baseBranch: string | null;
  /** Spec 30: per-card plan critic override; null/undefined defers to settings. */
  planCritic?: boolean | null;
  criticModel?: string | null;
};
