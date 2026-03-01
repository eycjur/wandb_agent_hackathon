export type DomainId = "resume_summary" | "resume_detail" | "self_pr";

export type DomainPromptConfig = {
  domain: DomainId;
  rubricVersion: number;
  passThreshold: number;
  targetInstruction: string;
  judgeInstruction: string;
  judgeRubric: string[];
  samples: Array<{
    title: string;
    input: string;
  }>;
};
