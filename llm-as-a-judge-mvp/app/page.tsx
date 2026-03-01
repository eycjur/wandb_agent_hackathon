"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { DomainId } from "@/lib/config/domainPromptLoader";
import type { DomainsListResponse } from "@/lib/contracts/generateEvaluate";
import {
  createInitialDomainSessions,
  patchDomainSession,
  type DomainSessionState
} from "@/lib/ui/domainSession";
import { GenerateTab } from "@/app/components/tabs/GenerateTab";
import { EvaluateTabContent } from "@/app/components/tabs/EvaluateTabContent";
import { JudgeImproveTab } from "@/app/components/tabs/JudgeImproveTab";
import { TargetImproveTab } from "@/app/components/tabs/TargetImproveTab";

type EvaluationResult = {
  domain: DomainId;
  rubricVersion: number;
  passThreshold: number;
  pass: boolean;
  userInput: string;
  generatedOutput: string;
  score: number;
  reason: string;
  createdAt: string;
};

const VALID_DOMAINS = ["resume_summary", "resume_detail", "self_pr"] as const;
type MainTab = "generation" | "evaluation" | "judge-improve" | "target-improve";

const TAB_IDS: MainTab[] = ["generation", "evaluation", "judge-improve", "target-improve"];
const TAB_LABELS: Record<MainTab, string> = {
  generation: "生成",
  evaluation: "評価",
  "judge-improve": "Judge プロンプト改善",
  "target-improve": "生成プロンプト改善"
};

function isDomainsListResponse(data: unknown): data is DomainsListResponse {
  if (typeof data !== "object" || data === null || !("domains" in data)) return false;
  const domains = (data as DomainsListResponse).domains;
  return (
    Array.isArray(domains) &&
    domains.every(
      (d) =>
        typeof d === "object" &&
        d !== null &&
        "id" in d &&
        "label" in d &&
        VALID_DOMAINS.includes(d.id as (typeof VALID_DOMAINS)[number])
    )
  );
}

function HomePageContent() {
  const searchParams = useSearchParams();
  const initialTab = (() => {
    const t = searchParams.get("tab");
    return (t && TAB_IDS.includes(t as MainTab)) ? (t as MainTab) : "generation";
  })();
  const [selectedDomain, setSelectedDomain] = useState<DomainId>("resume_summary");
  const [domainsList, setDomainsList] = useState<DomainsListResponse["domains"]>([]);
  const [activeMainTab, setActiveMainTab] = useState<MainTab>(initialTab);
  const [domainSessions, setDomainSessions] = useState<
    Record<DomainId, DomainSessionState<EvaluationResult>>
  >(() => createInitialDomainSessions<EvaluationResult>());
  const [judgeImproveDone, setJudgeImproveDone] = useState(false);
  const [targetImproveDone, setTargetImproveDone] = useState(false);

  const completedStepIndices = (() => {
    const indices: number[] = [];
    const hasGenerated = Object.values(domainSessions).some((s) => s.generatedOutput.length > 0);
    const hasEvaluated = Object.values(domainSessions).some((s) => s.currentResult != null);
    if (hasGenerated) indices.push(0);
    if (hasEvaluated) indices.push(1);
    if (judgeImproveDone) indices.push(2);
    if (targetImproveDone) indices.push(3);
    return indices;
  })();

  const onPatchDomainSession = useCallback(
    (domain: DomainId, patch: Partial<DomainSessionState<EvaluationResult>>) => {
      setDomainSessions((prev) => patchDomainSession(prev, domain, patch));
    },
    []
  );

  useEffect(() => {
    const loadDomainsList = async () => {
      try {
        const res = await fetch("/api/domains", { cache: "no-store" });
        if (!res.ok) return;
        const data: unknown = await res.json();
        if (isDomainsListResponse(data)) setDomainsList(data.domains);
      } catch {
        // ignore
      }
    };
    void loadDomainsList();
  }, []);

  return (
    <main className="shell">
      {domainsList.length > 0 && (
        <div className="domainSelector" role="group" aria-label="生成モード選択">
          <span className="domainSelectorLabel">生成モード:</span>
          <div className="domainSelectorButtons">
            {domainsList.map((d) => (
              <button
                key={d.id}
                type="button"
                className={`domainButton ${selectedDomain === d.id ? "active" : ""}`}
                onClick={() => setSelectedDomain(d.id)}
                aria-pressed={selectedDomain === d.id}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mainTabs" role="tablist" aria-label="メインビュータブ">
        {TAB_IDS.map((tabId) => (
          <button
            key={tabId}
            type="button"
            role="tab"
            id={`tab-${tabId}`}
            aria-controls={`panel-${tabId}`}
            aria-selected={activeMainTab === tabId}
            className={`tabButton ${activeMainTab === tabId ? "active" : ""}`}
            onClick={() => setActiveMainTab(tabId)}
          >
            {TAB_LABELS[tabId]}
          </button>
        ))}
      </div>

      {activeMainTab === "generation" && (
        <section
          id="panel-generation"
          role="tabpanel"
          aria-labelledby="tab-generation"
          className="tabPanel"
        >
          <GenerateTab
            selectedDomain={selectedDomain}
            domainSessions={domainSessions}
            onPatchDomainSession={onPatchDomainSession}
            onSwitchToEvaluate={() => setActiveMainTab("evaluation")}
            completedStepIndices={completedStepIndices}
          />
        </section>
      )}

      {activeMainTab === "evaluation" && (
        <section
          id="panel-evaluation"
          role="tabpanel"
          aria-labelledby="tab-evaluation"
          className="tabPanel"
        >
          <EvaluateTabContent
            selectedDomain={selectedDomain}
            domainSessions={domainSessions}
            onPatchDomainSession={onPatchDomainSession}
            onLoadingChange={() => {}}
            completedStepIndices={completedStepIndices}
          />
        </section>
      )}

      {activeMainTab === "judge-improve" && (
        <section
          id="panel-judge-improve"
          role="tabpanel"
          aria-labelledby="tab-judge-improve"
          className="tabPanel"
        >
          <JudgeImproveTab
            selectedDomain={selectedDomain}
            completedStepIndices={completedStepIndices}
            onImprovementGenerated={() => setJudgeImproveDone(true)}
          />
        </section>
      )}

      {activeMainTab === "target-improve" && (
        <section
          id="panel-target-improve"
          role="tabpanel"
          aria-labelledby="tab-target-improve"
          className="tabPanel"
        >
          <TargetImproveTab
            selectedDomain={selectedDomain}
            completedStepIndices={completedStepIndices}
            onImprovementGenerated={() => setTargetImproveDone(true)}
          />
        </section>
      )}
    </main>
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={<main className="shell"><p className="hintText">読み込み中...</p></main>}>
      <HomePageContent />
    </Suspense>
  );
}
