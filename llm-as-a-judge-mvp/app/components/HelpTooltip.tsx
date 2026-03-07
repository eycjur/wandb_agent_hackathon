"use client";

type Props = {
  text: string;
};

/** ホバーでツールチップを表示する ? アイコン */
export function HelpTooltip({ text }: Props) {
  return (
    <span className="helpTooltipWrapper" role="img" aria-label={text}>
      <span className="helpTooltipIcon">?</span>
      <span className="helpTooltipContent">{text}</span>
    </span>
  );
}

/** GEPA パラメータのツールチップ文言 */
export const GEPA_PARAM_TOOLTIPS = {
  maxIterations:
    "最大イテレーション数。リフレクション→提案→評価の最大繰り返し数。",
  numTrials:
    "1イテレーションあたりの候補数。多いほど探索が広がるが時間がかかる。",
  earlyStoppingTrials:
    "改善なしが何イテレーション連続したら早期終了するか。",
  maxExamples:
    "評価に使う例の最大数。評価が低い（改善余地が大きい）例を優先して選ぶ。少ないほど高速だが精度は落ちる。",
  compileTimeoutSeconds:
    "タイムアウト(秒)。0=無制限。指定秒数で打ち切り、それまでのベストを返す。"
} as const;

/** ログレベルのツールチップ文言 */
export const LOG_LEVEL_TOOLTIP =
  "最適化実行時のログ出力レベル。debug で LLM 呼び出しの開始・終了・所要時間を出力。未指定時は環境変数 GEPA_LOG_LEVEL に従う。";

/** Few-shot パラメータのツールチップ文言 */
export const FEWSHOT_PARAM_TOOLTIPS = {
  maxDemos:
    "Few-shot プロンプトに埋め込むデモの最大件数。多いほど例示が豊富になるがトークン消費が増える。",
  maxRounds:
    "デモセットの組み合わせを試すラウンド数。多いほど探索が広がるが時間がかかる。",
  demoThreshold:
    "デモとして採用するメトリクス閾値(0〜1)。このスコア以上の Teacher 出力のみデモ候補になる。",
  compileTimeoutSeconds:
    "タイムアウト(秒)。0=無制限。指定秒数で打ち切り、それまでのベストを返す。"
} as const;
