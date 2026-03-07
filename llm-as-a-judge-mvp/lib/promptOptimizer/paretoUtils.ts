/**
 * Pareto 最適化ユーティリティ
 * - ベクトル空間での非支配解の構築
 * - インスタンスフロント頻度による親選択（Algorithm 2）
 */

export type ScoreVector = Record<string, number>;

const TIE_EPSILON = 1e-9;

/** ベクトル配列の平均を返す */
export function avgVec(vecs: ScoreVector[]): ScoreVector {
  if (vecs.length === 0) return {};
  const keys = new Set<string>();
  for (const v of vecs) for (const k of Object.keys(v)) keys.add(k);
  const result: ScoreVector = {};
  for (const k of keys) {
    const vals = vecs.map((v) => Number(v[k])).filter(Number.isFinite);
    result[k] = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }
  return result;
}

/** ベクトルをスカラーに変換（重み付き合計。未指定時は平均） */
export function scalarize(
  v: ScoreVector,
  weights?: Record<string, number>
): number {
  const keys = Object.keys(v);
  if (keys.length === 0) return 0;
  if (weights) {
    let sum = 0;
    let wSum = 0;
    for (const k of keys) {
      const val = Number(v[k]);
      const w = weights[k] ?? 1;
      if (Number.isFinite(val)) {
        sum += val * w;
        wSum += w;
      }
    }
    return wSum > 0 ? sum / wSum : 0;
  }
  const vals = keys.map((k) => Number(v[k])).filter(Number.isFinite);
  return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

/** a が b を支配するか（全目的で a >= b かつ少なくとも1つで a > b） */
function dominates(a: ScoreVector, b: ScoreVector, epsilon = TIE_EPSILON): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let anyStrictlyBetter = false;
  for (const k of keys) {
    const va = Number(a[k] ?? 0);
    const vb = Number(b[k] ?? 0);
    if (va < vb - epsilon) return false;
    if (va > vb + epsilon) anyStrictlyBetter = true;
  }
  return anyStrictlyBetter;
}

/** vec が population のいずれかに支配されているか */
export function isDominatedByAny(
  vec: ScoreVector,
  population: ScoreVector[],
  epsilon = TIE_EPSILON
): boolean {
  for (const other of population) {
    if (dominates(other, vec, epsilon)) return true;
  }
  return false;
}

/** Pareto 非支配解のインデックスを返す */
export function buildParetoFront(
  items: Array<{ idx: number; scores: ScoreVector }>,
  epsilon = TIE_EPSILON
): number[] {
  const result: number[] = [];
  for (let i = 0; i < items.length; i++) {
    let dominated = false;
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue;
      if (dominates(items[j]!.scores, items[i]!.scores, epsilon)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) result.push(items[i]!.idx);
  }
  return result;
}

/**
 * 各 example について、どの候補が最良（スカラー）かを求める
 * instanceFronts[i] = example i で最良スコアを持つ候補のインデックス集合
 */
export function buildInstanceFronts(
  perInstanceScores: number[][],
  epsilon = TIE_EPSILON
): Set<number>[] {
  const nInst = perInstanceScores[0]?.length ?? 0;
  const fronts: Set<number>[] = [];
  for (let i = 0; i < nInst; i++) {
    let best = Number.NEGATIVE_INFINITY;
    const front = new Set<number>();
    for (let k = 0; k < perInstanceScores.length; k++) {
      const v = perInstanceScores[k]![i] ?? 0;
      if (v > best + epsilon) {
        best = v;
        front.clear();
        front.add(k);
      } else if (Math.abs(v - best) <= epsilon) {
        front.add(k);
      }
    }
    fronts.push(front);
  }
  return fronts;
}

/**
 * 各 example について、Pareto 非支配の候補を求める（スカラー化なし）
 * perInstanceVectors[k][i] = 候補 k の example i におけるスコアベクトル
 */
export function buildInstanceFrontsFromVectors(
  perInstanceVectors: ScoreVector[][],
  epsilon = TIE_EPSILON
): Set<number>[] {
  const nInst = perInstanceVectors[0]?.length ?? 0;
  const fronts: Set<number>[] = [];
  for (let i = 0; i < nInst; i++) {
    const items = perInstanceVectors.map((vecs, k) => ({
      idx: k,
      scores: vecs[i] ?? {}
    }));
    const frontIdx = buildParetoFront(items, epsilon);
    fronts.push(new Set(frontIdx));
  }
  return fronts;
}

/** スコアベクトルの合計を返す（ソート用） */
export function sumVec(v: ScoreVector): number {
  return Object.values(v).filter((x) => Number.isFinite(Number(x))).reduce((a, b) => a + Number(b), 0);
}

/**
 * 辞書式順序でベクトルを比較（第一目的優先、同点なら第二目的...）
 * keys の順で降順。戻り値: a > b なら正、a < b なら負、同点なら 0
 */
export function lexicographicCompare(
  a: ScoreVector,
  b: ScoreVector,
  keys: string[]
): number {
  for (const k of keys) {
    const va = Number(a[k] ?? 0);
    const vb = Number(b[k] ?? 0);
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

/**
 * インスタンスフロント頻度で親候補を選択
 * 各 example で「最良」に選ばれた回数に比例する確率でサンプリング
 */
export function selectParentByInstanceFronts(
  instanceFronts: Set<number>[],
  perProgScores: number[],
  rand: () => number
): number {
  const nCandidates = perProgScores.length;
  if (nCandidates === 0) return 0;
  if (nCandidates === 1) return 0;

  // 各候補がフロントに含まれた回数（頻度）
  const freq = new Array<number>(nCandidates).fill(0);
  for (const front of instanceFronts) {
    for (const k of front) {
      freq[k]++;
    }
  }

  // 頻度が0の候補は一様サンプリング
  const total = freq.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    return Math.floor(rand() * nCandidates);
  }

  let r = rand() * total;
  for (let k = 0; k < nCandidates; k++) {
    r -= freq[k]!;
    if (r <= 0) return k;
  }
  return nCandidates - 1;
}
