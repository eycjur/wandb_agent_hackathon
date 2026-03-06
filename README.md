# Weave Hackathon

## 課題仮説

### 解決する課題

1. エージェントを構築するには、ドメインエキスパートが評価基準を明文化して、プロンプトとしてLLMが理解できる形で与える必要があるが、実際には「経験的に良い」や専門的でLLMが理解できない、微妙な基準をLLMへの指示に落とし込むことが難しいことで、エージェントの改善が進みにくい
2. （サービスによっては）一般的なフィードバック機能は、良し悪しの2択で何が良くて何が悪いか曖昧だったり、コメントを追加する機能があっても書くのが面倒で適切なフィードバックが与えられなかったりすることが多く、継続的な改善に利用しにくい
3. エキスパートも別業務があるので、継続的な改善のためにエキスパートに多大な協力を求め続けるのは難しい

### 解決方法

**ドメイン知識を資産化し、継続的に進化するAIエージェント運用基盤**

- ドメインエキスパートのフィードバックを分析して、文章生成エージェンとと評価エージェントのプロンプトを改善する機能を作成する
- この機能を「調整エージェント」と呼ぶ

```mermaid
flowchart TD
    Input["📝 改善対象<br/>(Judge / Target プロンプト)"]
    Input --> MethodSelect{"🔀 最適化手法選択"}

    MethodSelect -->|"meta"| Meta["① Meta プロンプト改善<br/>(Gemini+MCP で実行)"]
    MethodSelect -->|"fewshot"| FewShot["② Few-shot"]
    MethodSelect -->|"gepa"| GEPA["③ GEPA（多目的最適化）"]
    MethodSelect -->|"gemini プロバイダ指定<br/>"| GeminiMcp["Gemini + MCP<br/>Weave データ自律取得"]

    subgraph Meta["① Meta プロンプト改善"]
        direction TB
        M1["W&B MCP Server 経由で<br/>Weave Traces を自律取得"]
        M2["評価の乖離・失敗パターンを<br/>Gemini で多角分析"]
        M3["改善案3候補を生成し<br/>最適な1候補を選択"]
        M1 --> M2 --> M3
    end

    subgraph FewShot["② Few-shot"]
        direction TB
        F1["Weave から実ログを取得<br/>(gepaDataLoader)"]
        F2["AxBootstrapFewShot で<br/>入出力ペアを最適化データとして構成"]
        F3["実例に沿った改善案を生成"]
        F1 --> F2 --> F3
    end

    subgraph GEPA["③ GEPA"]
        direction TB
        G1["Weave から学習データを取得<br/>(gepaDataLoader)"]
        G2["複数候補プロンプトを反復探索<br/>（精度・安定性等を最適化）"]
        G3["各候補を同じ LLM 評価で再評価"]
        G4["最も改善した候補を選択<br/>失敗時はフォールバック"]
        G1 --> G2 --> G3 --> G4
    end

    subgraph GeminiMcp["Gemini + MCP"]
        direction TB
        GM1["W&B MCP Server 経由で<br/>Weave Traces を自律取得"]
        GM2["失敗パターン・根本原因を分析"]
        GM3["改善案を生成"]
        GM1 --> GM2 --> GM3
    end

    Meta --> Output
    FewShot --> Output
    GEPA --> Output
    GeminiMcp --> Output

    Output["📊 改善案出力<br/>改善プロンプト ＋ 分析サマリー<br/>(resultSource: gepa / standard)"]
    
    Output --> Review["👀 人間レビュー"]
    Review -->|"採用"| Apply["✅ プロンプト反映<br/>(Weave Prompts への Publish)"]
    Review -->|"却下・再試行"| MethodSelect

    subgraph Weave["🗄️ W&B Weave"]
        direction TB
        WT["Traces<br/>(生成・評価・人間評価<br/>ログ蓄積)"]
        WP["Prompts<br/>(プロンプト管理・<br/>バージョン管理)"]
    end

    Apply --> WP
    Meta -.->|"MCP 経由で自律取得"| WT
    FewShot -.->|"API 取得"| WT
    GEPA -.->|"API 取得"| WT
    GeminiMcp -.->|"MCP 経由で自律取得"| WT
```

### 技術的仮説

1. 調整エージェントは汎用プロンプトで構築可能
    1. フィードバック → 改善点抽出 → 指示改善という構造はドメイン依存ではないため、汎用的に設計できると予想
2. ドメイン知識はデータから抽出可能
    1. ドメイン知識は明示的に与えなくても、ユーザー入力、評価結果、プロンプト履歴から再構成できると予想

### 価値

- ドメインエキスパートの継続的な負担を最小限にしつつ、ドメインエキスパートが持っている暗黙知をエージェントに反映させて、顧客体験が向上する