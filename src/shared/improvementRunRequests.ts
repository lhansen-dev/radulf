export type CreateImprovementRunRequest = {
  repoId: string;
  baseBranch: string;
  budgetMinutes: string | number;
  focusPrompt: string;
  plannerModel: string;
  loopModel: string;
  evaluatorModel: string;
  maxIterations: string | number;
  timeoutMinutes: string | number;
};
