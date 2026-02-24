export type JudgeResult = {
  score: number;
  reason: string;
  rubricVersion: number;
  passThreshold: number;
  domain: "resume_summary";
};

export type GenerateEvaluateResult = {
  domain: "resume_summary";
  rubricVersion: number;
  passThreshold: number;
  pass: boolean;
  generatedOutput: string;
  score: number;
  reason: string;
};

export interface LLMProvider {
  name: string;
  models: {
    target: string;
    judge: string;
  };
  generateOutput(userInput: string): Promise<string>;
  judgeOutput(userInput: string, generatedOutput: string): Promise<JudgeResult>;
}
