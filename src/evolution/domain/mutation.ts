export interface MutationManifest {
  mutationId: string;
  targetFailureIds: string[];
  hypothesis: string;
  mechanism: string;
  changedComponents: Array<{
    componentType: string;
    beforeHash: string;
    afterHash: string;
  }>;
  predictedBenefits: string[];
  predictedRisks: string[];
  rollbackPlan: string;
}
