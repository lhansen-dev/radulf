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
  autoApprove: boolean;
  baseBranch: string | null;
};
