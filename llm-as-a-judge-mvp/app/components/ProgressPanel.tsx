"use client";

type StepState = "pending" | "active" | "done" | "failed";

export type ProgressPanelStep = {
  key: string;
  label: string;
};

/** Common 4 steps across all tabs: Generate → Evaluate → Judge Improve → Target Improve */
export const COMMON_PROGRESS_STEPS: readonly ProgressPanelStep[] = [
  { key: "generate", label: "Generate" },
  { key: "evaluate", label: "Evaluate" },
  { key: "judge-improve", label: "Judge Improve" },
  { key: "target-improve", label: "Target Improve" }
];

type Props = {
  steps: readonly ProgressPanelStep[];
  completedStepIndices: number[];
  statusMessage: string;
  error?: string;
  failedStepIndex?: number;
};

function getStepState(
  completedStepIndices: number[],
  stepIndex: number,
  failedStepIndex?: number
): StepState {
  if (failedStepIndex !== undefined) {
    if (stepIndex < failedStepIndex) return "done";
    if (stepIndex === failedStepIndex) return "failed";
    return "pending";
  }
  if (completedStepIndices.includes(stepIndex)) return "done";
  const activeStep = [0, 1, 2, 3].find((i) => !completedStepIndices.includes(i)) ?? 3;
  if (stepIndex === activeStep) return "active";
  return "pending";
}

export function ProgressPanel({
  steps,
  completedStepIndices,
  statusMessage,
  error,
  failedStepIndex
}: Props) {
  return (
    <section className="panel progressPanel" aria-live="polite">
      <h2>Progress</h2>
      <ol>
        {steps.map((step, index) => {
          const state = getStepState(
            completedStepIndices,
            index,
            failedStepIndex
          );
          return (
            <li key={step.key} className={`stepItem step-${state}`}>
              <span className="stepDot" />
              <span>{step.label}</span>
            </li>
          );
        })}
      </ol>
      <p className="statusLine" aria-live="polite">
        {statusMessage}
      </p>
      {error ? (
        <p className="errorBanner" role="alert" aria-live="assertive">
          {error}
        </p>
      ) : (
        <p className="errorPlaceholder" aria-hidden="true" />
      )}
    </section>
  );
}
