export interface DynamicReferenceHelp {
  id: string;
  title: string;
  summary: string;
  details: string[];
}

export interface SyntaxHelpContext {
  isKey: boolean;
  parents: string[];
}

const DYNAMIC_REFERENCE_HELP: Record<string, DynamicReferenceHelp> = {
  var: {
    id: "var",
    title: "Script Variable Reference",
    summary: "現在のスコープにあるスクリプト変数を参照します。",
    details: [
      "`set_variable` や `change_variable` で作られた変数を読むときに使います。",
      "定義場所は静的に追い切れないことが多く、値は実行時のスコープで決まります。",
      "例: `culture = var:selected_culture`",
    ],
  },
  local_var: {
    id: "local_var",
    title: "Local Variable Reference",
    summary: "現在のイベントチェーンや一時コンテキストに閉じたローカル変数を参照します。",
    details: [
      "短命な一時値の受け渡し向けです。",
      "他ファイルの静的定義ではなく、実行中コンテキストに存在する値を読む前提です。",
      "例: `faith = local_var:generated_faith`",
    ],
  },
  global_var: {
    id: "global_var",
    title: "Global Variable Reference",
    summary: "グローバルに保持された変数を参照します。",
    details: [
      "セーブ全体や広い共有状態に置いた値の参照向けです。",
      "どこかで設定されていれば使えますが、静的解析では初期化箇所を保証しづらいです。",
      "例: `has_doctrine = global_var:active_doctrine`",
    ],
  },
  scope: {
    id: "scope",
    title: "Scope Reference",
    summary: "現在アクセス可能な別スコープの値・対象を参照します。",
    details: [
      "`scope:actor` や `scope:recipient` のように、実行時に渡されたスコープ名を使います。",
      "参照先は呼び出し元や effect / trigger の文脈で決まります。",
      "例: `culture = scope:target_culture`",
    ],
  },
  event_target: {
    id: "event_target",
    title: "Event Target Reference",
    summary: "事前に保存されたイベントターゲットを参照します。",
    details: [
      "`save_scope_as` などで退避した対象を後で読む用途です。",
      "対象は character / title / province など実行時オブジェクトになりえます。",
      "例: `has_doctrine = event_target:selected_doctrine_holder`",
    ],
  },
  named_script_value: {
    id: "named_script_value",
    title: "Named Script Value Reference",
    summary: "名前付き script value の結果を参照します。",
    details: [
      "数値や動的評価結果を名前経由で使い回す用途です。",
      "静的な database 定義というより、評価式の参照です。",
      "例: `has_doctrine_parameter = named_script_value:chosen_parameter`",
    ],
  },
  named_script_value_item: {
    id: "named_script_value_item",
    title: "Named Script Value Item Reference",
    summary: "名前付き script value から選ばれた項目を参照します。",
    details: [
      "script value が返す候補や結果項目にアクセスするときの表現です。",
      "値は実行時評価に依存するため、静的定義の未解決警告対象には向きません。",
      "例: `doctrine = named_script_value_item:selected_doctrine`",
    ],
  },
};

const KEYWORD_HELP: Record<string, DynamicReferenceHelp> = {
  set_variable: {
    id: "set_variable",
    title: "Set Variable",
    summary: "現在のスコープに変数を作成または上書きします。",
    details: [
      "通常は `name = some_key` と `value = ...` を子要素に持ちます。",
      "後続で `var:some_key` から参照されます。",
      "例: `set_variable = { name = selected_culture value = root.culture }`",
    ],
  },
  change_variable: {
    id: "change_variable",
    title: "Change Variable",
    summary: "既存の変数値を加算・減算などで更新します。",
    details: [
      "対象変数は `name` で指定します。",
      "`add` や `subtract`、または `value` を組み合わせる書き方が一般的です。",
      "例: `change_variable = { name = progress add = 10 }`",
    ],
  },
  clear_variable: {
    id: "clear_variable",
    title: "Clear Variable",
    summary: "現在のスコープから変数を削除します。",
    details: [
      "不要になった一時変数の掃除に使います。",
      "削除後は `var:...` 参照が無効になるため、文脈依存です。",
      "例: `clear_variable = selected_culture`",
    ],
  },
  set_global_variable: {
    id: "set_global_variable",
    title: "Set Global Variable",
    summary: "グローバル変数を作成または更新します。",
    details: [
      "後続で `global_var:...` から参照されます。",
      "セーブ全体の共有状態や長寿命フラグ向けです。",
      "例: `set_global_variable = { name = active_doctrine value = scope:faith }`",
    ],
  },
  change_global_variable: {
    id: "change_global_variable",
    title: "Change Global Variable",
    summary: "グローバル変数を更新します。",
    details: [
      "共有カウンタや永続進捗の更新向けです。",
      "参照側は `global_var:...` です。",
      "例: `change_global_variable = { name = campaign_progress add = 1 }`",
    ],
  },
  clear_global_variable: {
    id: "clear_global_variable",
    title: "Clear Global Variable",
    summary: "グローバル変数を削除します。",
    details: [
      "共有状態のリセットに使います。",
      "削除後に `global_var:...` で読むと未設定扱いになります。",
      "例: `clear_global_variable = active_doctrine`",
    ],
  },
  save_scope_as: {
    id: "save_scope_as",
    title: "Save Scope As",
    summary: "現在のスコープ対象を名前付きで保存し、後で `scope:` や `event_target:` から参照できるようにします。",
    details: [
      "character / title / province などの対象を名前で退避する操作です。",
      "保存名は実行時コンテキストにぶら下がるため、静的定義としては見えません。",
      "例: `save_scope_as = actor`",
    ],
  },
  save_temporary_scope_as: {
    id: "save_temporary_scope_as",
    title: "Save Temporary Scope As",
    summary: "一時的な寿命のスコープ名として対象を保存します。",
    details: [
      "短い effect / trigger チェーンの中でだけ使う一時スコープ向けです。",
      "永続的な保存より局所的な受け渡しに向きます。",
      "例: `save_temporary_scope_as = generated_target`",
    ],
  },
  save_event_target_as: {
    id: "save_event_target_as",
    title: "Save Event Target As",
    summary: "イベントターゲットとして対象を保存し、`event_target:` から再参照できるようにします。",
    details: [
      "イベント文脈をまたいで対象を持ち回す用途です。",
      "参照側は `event_target:saved_name` になります。",
      "例: `save_event_target_as = selected_holder`",
    ],
  },
  exists: {
    id: "exists",
    title: "Exists Check",
    summary: "対象スコープや参照値が存在するかを調べます。",
    details: [
      "`exists = scope:actor` や `exists = var:selected_culture` のように使います。",
      "動的参照を読む前のガード条件としてよく使われます。",
    ],
  },
  name: {
    id: "name",
    title: "Name Field",
    summary: "文脈に応じて変数名・保存スコープ名・locキーなど複数の意味を持つフィールドです。",
    details: [
      "`set_variable` 配下では変数名、`option` 配下では loc キーになることがあります。",
      "このキー単体ではなく、親構文とセットで読む必要があります。",
    ],
  },
  value: {
    id: "value",
    title: "Value Field",
    summary: "変数代入や script value 評価で使う値フィールドです。",
    details: [
      "数値・スコープ値・動的参照のどれでも入りえます。",
      "`set_variable` や `named_script_value` 周辺で頻出します。",
    ],
  },
};

export function getDynamicReferenceHelp(value: string): DynamicReferenceHelp | null {
  const separator = value.indexOf(":");
  if (separator <= 0) {
    return null;
  }

  const prefix = value.slice(0, separator);
  return DYNAMIC_REFERENCE_HELP[prefix] ?? null;
}

export function getScriptSyntaxHelp(value: string, context?: SyntaxHelpContext): DynamicReferenceHelp | null {
  const dynamic = getDynamicReferenceHelp(value);
  if (dynamic) {
    return dynamic;
  }

  const help = KEYWORD_HELP[value];
  if (!help) {
    return null;
  }

  if (!context?.isKey) {
    return value === "exists" ? help : null;
  }

  if (value === "name") {
    const parent = context.parents[context.parents.length - 1] ?? "";
    return NAME_FIELD_PARENTS.has(parent) ? help : null;
  }

  if (value === "value") {
    const parent = context.parents[context.parents.length - 1] ?? "";
    return VALUE_FIELD_PARENTS.has(parent) ? help : null;
  }

  return help;
}

const NAME_FIELD_PARENTS = new Set([
  "set_variable",
  "change_variable",
  "set_global_variable",
  "change_global_variable",
  "set_local_variable",
  "change_local_variable",
  "option",
]);

const VALUE_FIELD_PARENTS = new Set([
  "set_variable",
  "change_variable",
  "set_global_variable",
  "change_global_variable",
  "set_local_variable",
  "change_local_variable",
  "named_script_value",
]);
