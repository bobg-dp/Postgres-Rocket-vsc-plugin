import * as vscode from "vscode";
import {
  ExplorerNode,
  PostgresTreeDataProvider,
  SavedConnection,
  SavedQueryTreeItem,
} from "./explorer";
import {
  ConnectionConfig,
  EditableTableData,
  PostgresService,
  SqlAutocompleteColumn,
} from "./postgresService";

const CONNECTIONS_KEY = "postgresPlugin.connections";
const PASSWORD_KEY_PREFIX = "postgresPlugin.password.";
const SAVED_QUERIES_KEY_PREFIX = "postgresPlugin.savedQueries.";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function createConnectionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getSavedConnections(
  context: vscode.ExtensionContext,
): SavedConnection[] {
  return context.globalState.get<SavedConnection[]>(CONNECTIONS_KEY, []);
}

async function saveConnections(
  context: vscode.ExtensionContext,
  connections: SavedConnection[],
): Promise<void> {
  await context.globalState.update(CONNECTIONS_KEY, connections);
}

interface ConnectionFormData {
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
}

interface SavedSqlQuery {
  id: string;
  name: string;
  sql: string;
  createdAt: string;
  updatedAt: string;
}

interface OpenQueryPanelOptions {
  initialQuery?: SavedSqlQuery;
}

interface QueryExecutionResultPayload {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  command: string;
  durationMs: number;
  editable?: {
    schema: string;
    table: string;
    ctidField: string;
    columnTypes: Record<string, string>;
  };
}

interface QueryResultChangeEntry {
  ctid: string;
  changes: Record<string, unknown>;
}

interface SqlAutocompleteSuggestion {
  label: string;
  insertText: string;
  kind: "table" | "column" | "keyword";
  detail?: string;
}

interface AutocompleteRequestPayload {
  prefix: string;
  tableQualifier?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function validateConnectionFormData(
  data: Partial<ConnectionFormData>,
): { ok: true; value: ConnectionFormData } | { ok: false; message: string } {
  const name = (data.name ?? "").trim();
  const host = (data.host ?? "").trim();
  const database = (data.database ?? "").trim();
  const user = (data.user ?? "").trim();
  const password = data.password ?? "";
  const port = Number(data.port);
  const ssl = Boolean(data.ssl);

  if (!name) {
    return { ok: false, message: "Connection name is required." };
  }

  if (!host) {
    return { ok: false, message: "Host is required." };
  }

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, message: "Port must be a number in range 1-65535." };
  }

  if (!database) {
    return { ok: false, message: "Database is required." };
  }

  if (!user) {
    return { ok: false, message: "User is required." };
  }

  return {
    ok: true,
    value: {
      name,
      host,
      port,
      database,
      user,
      password,
      ssl,
    },
  };
}

function getConnectionFormHtml(
  defaults: ConnectionFormData,
  title: string,
): string {
  const escaped = {
    name: escapeHtml(defaults.name),
    host: escapeHtml(defaults.host),
    port: String(defaults.port),
    database: escapeHtml(defaults.database),
    user: escapeHtml(defaults.user),
    password: escapeHtml(defaults.password),
  };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      font-family: var(--vscode-font-family);
      margin: 0;
      padding: 20px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    h1 {
      margin: 0 0 16px 0;
      font-size: 18px;
      font-weight: 600;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .inline-field {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: center;
    }
    .field.full {
      grid-column: 1 / -1;
    }
    label {
      font-size: 12px;
      opacity: 0.9;
    }
    input, select {
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      padding: 8px 10px;
      border-radius: 6px;
      outline: none;
    }
    input:focus, select:focus {
      border-color: var(--vscode-focusBorder);
    }
    .actions {
      margin-top: 16px;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    button {
      border: 1px solid var(--vscode-button-border);
      border-radius: 6px;
      padding: 7px 12px;
      cursor: pointer;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .status {
      margin-top: 14px;
      font-size: 12px;
      min-height: 20px;
    }
    .status.ok {
      color: var(--vscode-testing-iconPassed);
    }
    .status.error {
      color: var(--vscode-testing-iconFailed);
    }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="grid">
    <div class="field full">
      <label for="name">Connection Name</label>
      <input id="name" value="${escaped.name}" />
    </div>
    <div class="field">
      <label for="host">Host</label>
      <input id="host" value="${escaped.host}" />
    </div>
    <div class="field">
      <label for="port">Port</label>
      <input id="port" type="number" min="1" max="65535" value="${escaped.port}" />
    </div>
    <div class="field">
      <label for="database">Database</label>
      <input id="database" value="${escaped.database}" />
    </div>
    <div class="field">
      <label for="user">User</label>
      <input id="user" value="${escaped.user}" />
    </div>
    <div class="field">
      <label for="password">Password</label>
      <div class="inline-field">
        <input id="password" type="password" value="${escaped.password}" />
        <button id="passwordToggle" type="button" class="secondary">Show</button>
      </div>
    </div>
    <div class="field">
      <label for="ssl">SSL</label>
      <select id="ssl">
        <option value="false" ${defaults.ssl ? "" : "selected"}>No SSL</option>
        <option value="true" ${defaults.ssl ? "selected" : ""}>Use SSL</option>
      </select>
    </div>
  </div>

  <div class="actions">
    <button id="test" type="button" class="secondary">Test Connection</button>
    <button id="save" type="button">Save Connection</button>
    <button id="cancel" type="button" class="secondary">Cancel</button>
  </div>
  <div id="status" class="status"></div>

  <script>
    const vscode = acquireVsCodeApi();
    const statusElement = document.getElementById("status");
    const testButton = document.getElementById("test");
    const passwordInput = document.getElementById("password");
    const passwordToggle = document.getElementById("passwordToggle");

    function payload() {
      return {
        name: document.getElementById("name").value,
        host: document.getElementById("host").value,
        port: Number(document.getElementById("port").value),
        database: document.getElementById("database").value,
        user: document.getElementById("user").value,
        password: document.getElementById("password").value,
        ssl: document.getElementById("ssl").value === "true"
      };
    }

    function setStatus(message, isError) {
      statusElement.textContent = message;
      statusElement.className = isError ? "status error" : "status ok";
    }

    document.getElementById("test").addEventListener("click", () => {
      testButton.disabled = true;
      setStatus("Testing connection...", false);
      vscode.postMessage({ type: "test", payload: payload() });
    });

    document.getElementById("save").addEventListener("click", () => {
      vscode.postMessage({ type: "save", payload: payload() });
    });

    document.getElementById("cancel").addEventListener("click", () => {
      vscode.postMessage({ type: "cancel" });
    });

    passwordToggle.addEventListener("click", () => {
      const currentlyHidden = passwordInput.type === "password";
      passwordInput.type = currentlyHidden ? "text" : "password";
      passwordToggle.textContent = currentlyHidden ? "Hide" : "Show";
    });

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (!msg || msg.type !== "testResult") {
        return;
      }

      testButton.disabled = false;
      setStatus(msg.message, !msg.ok);
    });
  </script>
</body>
</html>`;
}

interface OpenConnectionFormOptions {
  title: string;
  defaults?: Partial<ConnectionFormData>;
}

async function openConnectionFormPanel(
  options: OpenConnectionFormOptions,
): Promise<ConnectionFormData | undefined> {
  const defaults: ConnectionFormData = {
    name: "New Connection",
    host: "localhost",
    port: 5432,
    database: "postgres",
    user: "postgres",
    password: "",
    ssl: false,
    ...options.defaults,
  };

  const panel = vscode.window.createWebviewPanel(
    "postgresPlugin.createConnection",
    options.title,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );

  panel.webview.html = getConnectionFormHtml(defaults, options.title);

  return new Promise<ConnectionFormData | undefined>((resolve) => {
    let isResolved = false;

    const finalize = (value: ConnectionFormData | undefined) => {
      if (isResolved) {
        return;
      }

      isResolved = true;
      resolve(value);
    };

    panel.onDidDispose(() => finalize(undefined));

    panel.webview.onDidReceiveMessage(async (message: unknown) => {
      const payload =
        typeof message === "object" && message !== null
          ? (message as {
              type?: string;
              payload?: Partial<ConnectionFormData>;
            })
          : undefined;

      if (!payload?.type) {
        return;
      }

      if (payload.type === "cancel") {
        panel.dispose();
        return;
      }

      if (payload.type === "test") {
        const validation = validateConnectionFormData(payload.payload ?? {});
        if (!validation.ok) {
          await panel.webview.postMessage({
            type: "testResult",
            ok: false,
            message: validation.message,
          });
          return;
        }

        const testService = new PostgresService();
        try {
          const testConfig: ConnectionConfig = {
            host: validation.value.host,
            port: validation.value.port,
            database: validation.value.database,
            user: validation.value.user,
            password: validation.value.password,
            ssl: validation.value.ssl,
          };

          await testService.connect(testConfig);
          await panel.webview.postMessage({
            type: "testResult",
            ok: true,
            message: "Connection successful.",
          });
        } catch (error) {
          await panel.webview.postMessage({
            type: "testResult",
            ok: false,
            message: getErrorMessage(error),
          });
        } finally {
          await testService.disconnect();
        }

        return;
      }

      if (payload.type === "save") {
        const validation = validateConnectionFormData(payload.payload ?? {});
        if (!validation.ok) {
          await panel.webview.postMessage({
            type: "testResult",
            ok: false,
            message: validation.message,
          });
          return;
        }

        finalize(validation.value);
        panel.dispose();
      }
    });
  });
}

async function askConnectionPassword(
  existingPassword?: string,
): Promise<string | undefined> {
  const password = await vscode.window.showInputBox({
    title: "Connect PostgreSQL",
    prompt: "Password",
    value: existingPassword ?? "",
    password: true,
    ignoreFocusOut: true,
  });

  if (password === undefined) {
    return undefined;
  }

  return password;
}

async function toConnectionConfig(
  context: vscode.ExtensionContext,
  connection: SavedConnection,
): Promise<ConnectionConfig | undefined> {
  const passwordKey = `${PASSWORD_KEY_PREFIX}${connection.id}`;
  let password = await context.secrets.get(passwordKey);

  if (password === undefined) {
    password = await askConnectionPassword();
    if (password === undefined) {
      return undefined;
    }

    await context.secrets.store(passwordKey, password);
  }

  return {
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    password,
    ssl: connection.ssl,
  };
}

function getSavedSqlQueries(
  context: vscode.ExtensionContext,
  connectionId: string,
): SavedSqlQuery[] {
  return context.globalState.get<SavedSqlQuery[]>(
    `${SAVED_QUERIES_KEY_PREFIX}${connectionId}`,
    [],
  );
}

async function saveSqlQueries(
  context: vscode.ExtensionContext,
  connectionId: string,
  queries: SavedSqlQuery[],
): Promise<void> {
  await context.globalState.update(
    `${SAVED_QUERIES_KEY_PREFIX}${connectionId}`,
    queries,
  );
}

function getSavedQueriesForTree(
  context: vscode.ExtensionContext,
  connectionId: string,
): SavedQueryTreeItem[] {
  return getSavedSqlQueries(context, connectionId).map((query) => ({
    id: query.id,
    name: query.name,
    updatedAt: query.updatedAt,
  }));
}

function getSavedQueryFromNode(
  context: vscode.ExtensionContext,
  node?: ExplorerNode,
): { connectionId: string; query: SavedSqlQuery } | undefined {
  if (!node?.connectionId || !node?.queryId) {
    return undefined;
  }

  const query = getSavedSqlQueries(context, node.connectionId).find(
    (item) => item.id === node.queryId,
  );
  if (!query) {
    return undefined;
  }

  return {
    connectionId: node.connectionId,
    query,
  };
}

function toQueryResultPayload(
  result: Awaited<ReturnType<PostgresService["execute"]>>,
  durationMs: number,
  editable?: QueryExecutionResultPayload["editable"],
): QueryExecutionResultPayload {
  const columnsFromFields = result.fields.map((field) => field.name);
  const columns =
    columnsFromFields.length > 0
      ? columnsFromFields
      : Object.keys(result.rows[0] ?? {});

  return {
    columns,
    rows: result.rows as Array<Record<string, unknown>>,
    rowCount: result.rowCount ?? 0,
    command: result.command,
    durationMs,
    editable,
  };
}

interface EditableSelectTarget {
  schema: string;
  table: string;
}

function parseSimpleEditableSelectTarget(sql: string): EditableSelectTarget | undefined {
  const normalized = sql.trim();
  if (!/^select\b/i.test(normalized)) {
    return undefined;
  }

  if (/\b(join|union|intersect|except|group\s+by|distinct)\b/i.test(normalized)) {
    return undefined;
  }

  const fromMatch = normalized.match(
    /\bfrom\s+((?:"[^"]+"|[a-zA-Z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[a-zA-Z_][\w$]*))?)/i,
  );
  if (!fromMatch?.[1]) {
    return undefined;
  }

  const source = fromMatch[1].replace(/\s+/g, "");
  if (source.includes(",")) {
    return undefined;
  }

  const parts = source.split(".");
  const unquote = (value: string) =>
    value.startsWith('"') && value.endsWith('"')
      ? value.slice(1, -1).replace(/""/g, '"')
      : value;

  if (parts.length === 1) {
    return {
      schema: "public",
      table: unquote(parts[0]),
    };
  }

  if (parts.length === 2) {
    return {
      schema: unquote(parts[0]),
      table: unquote(parts[1]),
    };
  }

  return undefined;
}

function ensureEditableCtidProjection(sql: string): string {
  if (/\b(__ctid__|ctid)\b/i.test(sql)) {
    return sql;
  }

  return sql.replace(
    /^(\s*select\s+)/i,
    "$1ctid::text AS __ctid__, ",
  );
}

function normalizeIdentifier(value: string): string {
  return value.replace(/"/g, "").toLowerCase();
}

function buildAutocompleteSuggestions(
  metadata: SqlAutocompleteColumn[],
  request: AutocompleteRequestPayload,
): SqlAutocompleteSuggestion[] {
  const prefix = (request.prefix ?? "").toLowerCase();
  const qualifier = request.tableQualifier
    ? normalizeIdentifier(request.tableQualifier)
    : "";
  const suggestions: SqlAutocompleteSuggestion[] = [];
  const seen = new Set<string>();

  if (qualifier) {
    for (const item of metadata) {
      const table = item.table.toLowerCase();
      const schemaTable = `${item.schema}.${item.table}`.toLowerCase();
      if (table !== qualifier && schemaTable !== qualifier) {
        continue;
      }

      const columnLower = item.column.toLowerCase();
      if (prefix && !columnLower.startsWith(prefix)) {
        continue;
      }

      const key = `column:${item.column.toLowerCase()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      suggestions.push({
        label: item.column,
        insertText: item.column,
        kind: "column",
        detail: `${item.schema}.${item.table}`,
      });
    }

    return suggestions.slice(0, 30);
  }

  for (const item of metadata) {
    const schemaTable = `${item.schema}.${item.table}`;
    const tableLower = item.table.toLowerCase();
    const schemaTableLower = schemaTable.toLowerCase();
    const matchTable =
      !prefix || tableLower.startsWith(prefix) || schemaTableLower.startsWith(prefix);

    if (matchTable) {
      const key = `table:${schemaTableLower}`;
      if (!seen.has(key)) {
        seen.add(key);
        suggestions.push({
          label: schemaTable,
          insertText: schemaTable,
          kind: "table",
          detail: "table",
        });
      }
    }
  }

  for (const item of metadata) {
    const columnLower = item.column.toLowerCase();
    if (prefix && !columnLower.startsWith(prefix)) {
      continue;
    }

    const key = `column:${columnLower}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    suggestions.push({
      label: item.column,
      insertText: item.column,
      kind: "column",
      detail: `${item.schema}.${item.table}`,
    });
  }

  const sqlKeywords = [
    "SELECT",
    "FROM",
    "WHERE",
    "INSERT",
    "UPDATE",
    "DELETE",
    "JOIN",
    "ORDER BY",
    "GROUP BY",
    "LIMIT",
    "RETURNING",
  ];
  for (const keyword of sqlKeywords) {
    const lower = keyword.toLowerCase();
    if (prefix && !lower.startsWith(prefix)) {
      continue;
    }

    const key = `keyword:${lower}`;
    if (seen.has(key)) {
      continue;
    }

    suggestions.push({
      label: keyword,
      insertText: keyword,
      kind: "keyword",
      detail: "keyword",
    });
  }

  return suggestions.slice(0, 40);
}

function getQueryPanelHtml(
  connectionName: string,
  initialSql: string,
  initialQueryName?: string,
): string {
  const payload = JSON.stringify({
    connectionName,
    initialSql,
    initialQueryName,
  }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SQL Query Panel</title>
  <style>
    body {
      margin: 0;
      padding: 16px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }
    .title {
      font-size: 14px;
      font-weight: 600;
    }
    .status {
      min-height: 18px;
      font-size: 12px;
      margin-bottom: 10px;
    }
    .status.ok {
      color: var(--vscode-testing-iconPassed);
    }
    .status.error {
      color: var(--vscode-testing-iconFailed);
    }
    .editor-wrap {
      display: grid;
      gap: 8px;
      margin-bottom: 12px;
    }
    textarea {
      width: 100%;
      min-height: 180px;
      resize: vertical;
      box-sizing: border-box;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 8px;
      padding: 10px;
      outline: none;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 13px;
      line-height: 1.45;
    }
    textarea:focus {
      border-color: var(--vscode-focusBorder);
    }
    .autocomplete {
      border: 1px solid var(--vscode-editorWidget-border);
      background: var(--vscode-editorWidget-background);
      border-radius: 6px;
      overflow: hidden;
    }
    .autocomplete.hidden {
      display: none;
    }
    .autocomplete-header {
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-editorWidget-border);
      font-size: 11px;
      opacity: 0.85;
    }
    .autocomplete-list {
      max-height: 180px;
      overflow: auto;
    }
    .autocomplete-item {
      width: 100%;
      border: none;
      border-bottom: 1px solid var(--vscode-editorWidget-border);
      background: transparent;
      color: var(--vscode-foreground);
      padding: 7px 9px;
      cursor: pointer;
      text-align: left;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      font-size: 12px;
    }
    .autocomplete-item:last-child {
      border-bottom: none;
    }
    .autocomplete-item.active {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }
    .autocomplete-item .detail {
      font-size: 11px;
      opacity: 0.8;
    }
    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    button {
      border: 1px solid var(--vscode-button-border);
      border-radius: 6px;
      padding: 7px 12px;
      cursor: pointer;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .query-info {
      min-height: 18px;
      margin: -4px 0 8px 0;
      font-size: 12px;
      opacity: 0.85;
    }
    .results {
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 8px;
      overflow: hidden;
    }
    .results-header {
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-editorWidget-border);
      background: var(--vscode-sideBar-background);
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex-wrap: wrap;
    }
    .results-search {
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-editorWidget-border);
      background: var(--vscode-editor-background);
    }
    .results-search input {
      flex: 1;
      min-width: 180px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 6px;
      padding: 7px 10px;
      outline: none;
    }
    .results-search input:focus {
      border-color: var(--vscode-focusBorder);
    }
    .results-body {
      max-height: 46vh;
      overflow: auto;
    }
    .results-save.hidden {
      display: none;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 640px;
    }
    th,
    td {
      border-bottom: 1px solid var(--vscode-editorWidget-border);
      text-align: left;
      vertical-align: top;
      padding: 7px 9px;
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: var(--vscode-sideBar-background);
      font-weight: 600;
    }
    .empty {
      padding: 14px;
      font-size: 12px;
      opacity: 0.85;
    }
    .editable-cell-input {
      width: 100%;
      border: none;
      outline: none;
      background: transparent;
      color: var(--vscode-input-foreground);
      padding: 6px 8px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      cursor: pointer;
      box-sizing: border-box;
    }
    .editable-cell-input.changed {
      background: #1f4f2d55;
    }
    .modal {
      position: fixed;
      inset: 0;
      background: #00000066;
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 10;
    }
    .modal.visible {
      display: flex;
    }
    .modal-body {
      width: min(760px, 92vw);
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 10px;
      padding: 14px;
      display: grid;
      gap: 10px;
    }
    .modal-title {
      font-size: 13px;
      font-weight: 600;
    }
    .modal-input,
    .modal-textarea {
      width: 100%;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 6px;
      padding: 8px;
      box-sizing: border-box;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .modal-textarea {
      min-height: 220px;
      resize: vertical;
    }
    .modal-error {
      min-height: 16px;
      font-size: 12px;
      color: var(--vscode-testing-iconFailed);
    }
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div id="title" class="title"></div>
  </div>

  <div id="status" class="status"></div>
  <div id="queryInfo" class="query-info"></div>

  <div class="editor-wrap">
    <textarea id="sqlInput" placeholder="Write SQL query here..."></textarea>
    <div id="autocomplete" class="autocomplete hidden">
      <div class="autocomplete-header">Suggestions (Ctrl+Space)</div>
      <div id="autocompleteList" class="autocomplete-list"></div>
    </div>
    <div class="actions">
      <button id="proceedButton" type="button"><span aria-hidden="true">&#9654;</span><span>Proceed</span></button>
      <button id="saveButton" type="button" class="secondary"><span aria-hidden="true">&#128190;</span><span>Save</span></button>
      <button id="saveResultChangesButton" type="button" class="results-save hidden"><span aria-hidden="true">&#10003;</span><span>Save Result Changes</span></button>
    </div>
  </div>

  <div class="results">
    <div id="resultsHeader" class="results-header"></div>
    <div class="results-search">
      <input id="resultsSearchInput" type="text" placeholder="Filter result rows..." />
      <button id="resultsSearchClearButton" type="button" class="secondary">Clear</button>
    </div>
    <div id="resultsBody" class="results-body"></div>
  </div>

  <div id="cellModal" class="modal" role="dialog" aria-modal="true">
    <div class="modal-body">
      <div id="cellModalTitle" class="modal-title"></div>
      <input id="cellModalInput" class="modal-input" />
      <textarea id="cellModalTextarea" class="modal-textarea"></textarea>
      <div id="cellModalError" class="modal-error"></div>
      <div class="modal-actions">
        <button id="cellModalCancel" type="button" class="secondary">Cancel</button>
        <button id="cellModalSave" type="button">Apply</button>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const initialState = ${payload};

    const title = document.getElementById("title");
    const status = document.getElementById("status");
    const queryInfo = document.getElementById("queryInfo");
    const sqlInput = document.getElementById("sqlInput");
    const autocomplete = document.getElementById("autocomplete");
    const autocompleteList = document.getElementById("autocompleteList");
    const proceedButton = document.getElementById("proceedButton");
    const saveButton = document.getElementById("saveButton");
    const saveResultChangesButton = document.getElementById("saveResultChangesButton");
    const resultsHeader = document.getElementById("resultsHeader");
    const resultsSearchInput = document.getElementById("resultsSearchInput");
    const resultsSearchClearButton = document.getElementById("resultsSearchClearButton");
    const resultsBody = document.getElementById("resultsBody");
    const cellModal = document.getElementById("cellModal");
    const cellModalTitle = document.getElementById("cellModalTitle");
    const cellModalInput = document.getElementById("cellModalInput");
    const cellModalTextarea = document.getElementById("cellModalTextarea");
    const cellModalError = document.getElementById("cellModalError");
    const cellModalCancel = document.getElementById("cellModalCancel");
    const cellModalSave = document.getElementById("cellModalSave");

    let activeSuggestions = [];
    let activeSuggestionIndex = -1;
    let latestResultPayload = null;
    let resultSearchQuery = "";
    let resultChangesByRow = new Map();
    let currentModalContext = null;
    let lastAutocompleteContext = {
      replaceStart: 0,
      replaceEnd: 0,
    };

    title.textContent = "SQL panel: " + String(initialState.connectionName || "connection");
    sqlInput.value = String(initialState.initialSql || "");
    queryInfo.textContent = initialState.initialQueryName
      ? "Editing saved query: " + String(initialState.initialQueryName)
      : "Editing ad-hoc query";

    function setStatus(message, ok) {
      status.textContent = message;
      status.className = ok ? "status ok" : "status error";
    }

    function hideAutocomplete() {
      activeSuggestions = [];
      activeSuggestionIndex = -1;
      autocomplete.classList.add("hidden");
      autocompleteList.innerHTML = "";
    }

    function showAutocomplete() {
      autocomplete.classList.remove("hidden");
    }

    function getAutocompleteContext() {
      const sql = String(sqlInput.value || "");
      const cursor = Number(sqlInput.selectionStart || 0);
      const left = sql.slice(0, cursor);
      const match = left.match(/([A-Za-z_][A-Za-z0-9_\.]*)$/);
      const token = match ? match[1] : "";
      const tokenStart = match ? cursor - token.length : cursor;
      const dotIndex = token.lastIndexOf(".");
      const tableQualifier = dotIndex >= 0 ? token.slice(0, dotIndex) : "";
      const prefix = dotIndex >= 0 ? token.slice(dotIndex + 1) : token;

      return {
        prefix,
        tableQualifier,
        replaceStart: dotIndex >= 0 ? tokenStart + dotIndex + 1 : tokenStart,
        replaceEnd: cursor,
      };
    }

    function applySuggestion(index) {
      const suggestion = activeSuggestions[index];
      if (!suggestion) {
        return;
      }

      const sql = String(sqlInput.value || "");
      const before = sql.slice(0, lastAutocompleteContext.replaceStart);
      const after = sql.slice(lastAutocompleteContext.replaceEnd);
      const inserted = suggestion.insertText;
      const nextValue = before + inserted + after;
      sqlInput.value = nextValue;

      const nextCursor = before.length + inserted.length;
      sqlInput.focus();
      sqlInput.setSelectionRange(nextCursor, nextCursor);
      hideAutocomplete();
    }

    function renderAutocomplete() {
      autocompleteList.innerHTML = "";
      if (!activeSuggestions.length) {
        hideAutocomplete();
        return;
      }

      activeSuggestions.forEach((suggestion, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "autocomplete-item" +
          (index === activeSuggestionIndex ? " active" : "");

        const label = document.createElement("span");
        label.textContent = suggestion.label;

        const detail = document.createElement("span");
        detail.className = "detail";
        detail.textContent = suggestion.kind +
          (suggestion.detail ? " | " + suggestion.detail : "");

        button.appendChild(label);
        button.appendChild(detail);
        button.addEventListener("click", () => {
          applySuggestion(index);
        });

        autocompleteList.appendChild(button);
      });

      showAutocomplete();
    }

    function requestAutocomplete(force = false) {
      const ctx = getAutocompleteContext();
      const hasDot = Boolean(ctx.tableQualifier);
      const hasPrefix = ctx.prefix.length > 0;
      if (!force && !hasPrefix && !hasDot) {
        hideAutocomplete();
        return;
      }

      lastAutocompleteContext = {
        replaceStart: ctx.replaceStart,
        replaceEnd: ctx.replaceEnd,
      };

      vscode.postMessage({
        type: "autocomplete",
        payload: {
          prefix: ctx.prefix,
          tableQualifier: ctx.tableQualifier || undefined,
        },
      });
    }

    function toCellValue(value) {
      if (value === null || value === undefined) {
        return "NULL";
      }

      if (typeof value === "object") {
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      }

      return String(value);
    }

    function isJsonType(column, payload) {
      const columnTypes = (payload && payload.editable && payload.editable.columnTypes) || {};
      const type = String(columnTypes[column] || "").toLowerCase();
      return type === "json" || type === "jsonb";
    }

    function serializeInputValue(value) {
      if (value === null || value === undefined) {
        return "";
      }

      if (typeof value === "object") {
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      }

      return String(value);
    }

    function openCellModal(rowIndex, column, input, payload) {
      currentModalContext = { rowIndex, column, input, payload };
      cellModalError.textContent = "";
      const isJson = isJsonType(column, payload);

      cellModalTitle.textContent = isJson
        ? "Edit JSON: " + column
        : "Edit value: " + column;

      if (isJson) {
        cellModalInput.style.display = "none";
        cellModalTextarea.style.display = "block";

        try {
          const parsed = input.value.trim() ? JSON.parse(input.value) : null;
          cellModalTextarea.value = parsed === null ? "" : JSON.stringify(parsed, null, 2);
        } catch {
          cellModalTextarea.value = input.value;
        }
        cellModalTextarea.focus();
      } else {
        cellModalTextarea.style.display = "none";
        cellModalInput.style.display = "block";
        cellModalInput.value = input.value;
        cellModalInput.focus();
        cellModalInput.select();
      }

      cellModal.classList.add("visible");
    }

    function closeCellModal() {
      currentModalContext = null;
      cellModal.classList.remove("visible");
    }

    function markResultChanged(rowIndex, column, input) {
      const isChanged = input.value !== input.dataset.original;
      input.classList.toggle("changed", isChanged);

      const existing = resultChangesByRow.get(rowIndex) || {};
      if (isChanged) {
        existing[column] = input.value;
        resultChangesByRow.set(rowIndex, existing);
      } else {
        delete existing[column];
        if (Object.keys(existing).length === 0) {
          resultChangesByRow.delete(rowIndex);
        } else {
          resultChangesByRow.set(rowIndex, existing);
        }
      }

      saveResultChangesButton.disabled = resultChangesByRow.size === 0;
    }

    function convertResultChange(rawValue, column, payload) {
      const editable = payload && payload.editable;
      const columnTypes = (editable && editable.columnTypes) || {};
      const type = String(columnTypes[column] || "").toLowerCase();
      const trimmed = String(rawValue).trim();

      if (trimmed === "") {
        return null;
      }

      if (type === "boolean") {
        const normalized = trimmed.toLowerCase();
        if (normalized === "true" || normalized === "1") {
          return true;
        }
        if (normalized === "false" || normalized === "0") {
          return false;
        }
        throw new Error("Column " + column + ": expected boolean (true/false).");
      }

      const numericTypes = new Set([
        "smallint", "integer", "bigint", "decimal", "numeric", "real", "double precision",
        "smallserial", "serial", "bigserial"
      ]);
      if (numericTypes.has(type)) {
        const numeric = Number(trimmed);
        if (Number.isNaN(numeric)) {
          throw new Error("Column " + column + ": expected number.");
        }
        return numeric;
      }

      if (type === "json" || type === "jsonb") {
        try {
          return JSON.parse(rawValue);
        } catch {
          throw new Error("Column " + column + ": invalid JSON.");
        }
      }

      return rawValue;
    }

    function buildResultChangesPayload() {
      if (!latestResultPayload || !latestResultPayload.editable) {
        return [];
      }

      const ctidField = latestResultPayload.editable.ctidField;
      const changes = [];

      for (const [rowIndex, rowChanges] of resultChangesByRow.entries()) {
        const row = latestResultPayload.rows[rowIndex];
        if (!row) {
          continue;
        }

        const ctid = row[ctidField];
        if (ctid === undefined || ctid === null) {
          continue;
        }

        const converted = {};
        for (const [column, rawValue] of Object.entries(rowChanges)) {
          converted[column] = convertResultChange(rawValue, column, latestResultPayload);
        }

        changes.push({
          ctid: String(ctid),
          changes: converted,
        });
      }

      return changes;
    }

    function shouldRowMatchFilter(row, columns, query) {
      if (!query) {
        return true;
      }

      const normalized = query.toLowerCase();
      return columns.some((column) =>
        toCellValue(row[column]).toLowerCase().includes(normalized),
      );
    }

    function renderResults(nextPayload) {
      if (nextPayload !== undefined) {
        latestResultPayload = nextPayload || null;
        resultChangesByRow.clear();
        saveResultChangesButton.disabled = true;
      }

      const payload = latestResultPayload;

      if (!payload) {
        resultsHeader.textContent = "Run query to see results.";
        resultsBody.innerHTML = '<div class="empty">No results yet.</div>';
        saveResultChangesButton.classList.add("hidden");
        return;
      }

      const rowCount = Number(payload.rowCount || 0);
      const command = String(payload.command || "SQL");
      const duration = Number(payload.durationMs || 0);
      resultsHeader.textContent =
        command + " | rows: " + rowCount + " | time: " + duration + " ms";

      const columns = Array.isArray(payload.columns) ? payload.columns : [];
      const rows = Array.isArray(payload.rows) ? payload.rows : [];
      const editable = payload.editable || null;
      const editableColumns = editable
        ? columns.filter((column) => column !== editable.ctidField)
        : columns;
      const filteredRowEntries = rows
        .map((row, rowIndex) => ({ row, rowIndex }))
        .filter(({ row }) =>
          shouldRowMatchFilter(row, editableColumns, resultSearchQuery),
        );
      saveResultChangesButton.classList.toggle("hidden", !editable);

      if (!columns.length) {
        resultsBody.innerHTML = '<div class="empty">Query executed. No tabular data returned.</div>';
        return;
      }

      if (resultSearchQuery) {
        resultsHeader.textContent =
          command +
          " | rows: " + filteredRowEntries.length + "/" + rows.length +
          " | time: " + duration + " ms";
      }

      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");

      for (const column of editableColumns) {
        const th = document.createElement("th");
        th.textContent = String(column);
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);

      if (filteredRowEntries.length === 0) {
        resultsBody.innerHTML = '<div class="empty">No rows match current filter.</div>';
        return;
      }

      const tbody = document.createElement("tbody");
      filteredRowEntries.forEach(({ row, rowIndex }) => {
        const tr = document.createElement("tr");
        for (const column of editableColumns) {
          const td = document.createElement("td");
          if (editable) {
            const input = document.createElement("input");
            const originalValue = serializeInputValue(row[column]);
            const pendingRowChanges = resultChangesByRow.get(rowIndex) || {};
            const hasPendingValue = Object.prototype.hasOwnProperty.call(
              pendingRowChanges,
              column,
            );
            const currentValue = hasPendingValue
              ? String(pendingRowChanges[column] ?? "")
              : originalValue;
            input.className = "editable-cell-input";
            input.value = currentValue;
            input.dataset.original = originalValue;
            input.readOnly = true;
            input.classList.toggle("changed", currentValue !== originalValue);
            input.addEventListener("click", () => {
              openCellModal(rowIndex, column, input, payload);
            });
            td.appendChild(input);
          } else {
            td.textContent = toCellValue(row[column]);
          }
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      });

      table.appendChild(tbody);
      resultsBody.innerHTML = "";
      resultsBody.appendChild(table);
    }

    proceedButton.addEventListener("click", () => {
      const sql = sqlInput.value;
      vscode.postMessage({ type: "execute", payload: { sql } });
    });

    resultsSearchInput.addEventListener("input", () => {
      resultSearchQuery = String(resultsSearchInput.value || "").trim();
      renderResults();
    });

    resultsSearchClearButton.addEventListener("click", () => {
      if (!resultsSearchInput.value) {
        return;
      }

      resultsSearchInput.value = "";
      resultSearchQuery = "";
      renderResults();
      resultsSearchInput.focus();
    });

    saveResultChangesButton.addEventListener("click", () => {
      let changes;
      try {
        changes = buildResultChangesPayload();
      } catch (error) {
        setStatus(String(error instanceof Error ? error.message : error), false);
        return;
      }

      if (!changes.length || !latestResultPayload || !latestResultPayload.editable) {
        setStatus("No editable result changes to save.", false);
        return;
      }

      saveResultChangesButton.disabled = true;
      setStatus("Saving result changes...", true);
      vscode.postMessage({
        type: "saveResultChanges",
        payload: {
          schema: latestResultPayload.editable.schema,
          table: latestResultPayload.editable.table,
          changes,
        },
      });
    });

    sqlInput.addEventListener("input", () => {
      requestAutocomplete(false);
    });

    sqlInput.addEventListener("keydown", (event) => {
      if (event.key === " " && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        requestAutocomplete(true);
        return;
      }

      if (autocomplete.classList.contains("hidden")) {
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        activeSuggestionIndex = Math.min(
          activeSuggestions.length - 1,
          activeSuggestionIndex + 1,
        );
        renderAutocomplete();
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        activeSuggestionIndex = Math.max(0, activeSuggestionIndex - 1);
        renderAutocomplete();
        return;
      }

      if (event.key === "Enter" && activeSuggestionIndex >= 0) {
        event.preventDefault();
        applySuggestion(activeSuggestionIndex);
        return;
      }

      if (event.key === "Escape") {
        hideAutocomplete();
      }
    });

    saveButton.addEventListener("click", () => {
      const sql = sqlInput.value;
      vscode.postMessage({ type: "saveQuery", payload: { sql } });
    });

    cellModalCancel.addEventListener("click", () => {
      closeCellModal();
    });

    cellModalSave.addEventListener("click", () => {
      if (!currentModalContext) {
        return;
      }

      const { rowIndex, column, input, payload } = currentModalContext;
      const jsonMode = isJsonType(column, payload);
      const nextValue = jsonMode ? cellModalTextarea.value : cellModalInput.value;

      if (jsonMode && nextValue.trim() !== "") {
        try {
          const parsed = JSON.parse(nextValue);
          input.value = JSON.stringify(parsed);
        } catch {
          cellModalError.textContent = "Invalid JSON format.";
          return;
        }
      } else {
        input.value = nextValue;
      }

      markResultChanged(rowIndex, column, input);
      closeCellModal();
    });

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (!msg || !msg.type) {
        return;
      }

      if (msg.type === "status") {
        setStatus(String(msg.message || ""), Boolean(msg.ok));
        if (saveResultChangesButton) {
          saveResultChangesButton.disabled = false;
        }
        return;
      }

      if (msg.type === "result") {
        renderResults(msg.payload);
        return;
      }

      if (msg.type === "autocompleteSuggestions") {
        activeSuggestions = Array.isArray(msg.payload) ? msg.payload : [];
        activeSuggestionIndex = activeSuggestions.length > 0 ? 0 : -1;
        renderAutocomplete();
      }
    });

    renderResults(undefined);
  </script>
</body>
</html>`;
}

async function openQueryPanel(
  context: vscode.ExtensionContext,
  service: PostgresService,
  connection: SavedConnection,
  onQueriesChanged: () => void,
  options: OpenQueryPanelOptions = {},
): Promise<void> {
  let currentQuery = options.initialQuery;
  let autocompleteMetadata: SqlAutocompleteColumn[] | undefined;

  const getAutocompleteMetadata = async (): Promise<SqlAutocompleteColumn[]> => {
    if (!autocompleteMetadata) {
      autocompleteMetadata = await service.listAutocompleteColumns();
    }

    return autocompleteMetadata;
  };

  const panel = vscode.window.createWebviewPanel(
    "postgresPlugin.queryPanel",
    currentQuery
      ? `SQL: ${connection.name} / ${currentQuery.name}`
      : `SQL: ${connection.name}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );

  const readQueries = () => getSavedSqlQueries(context, connection.id);
  let lastExecutedSql: string | undefined;

  const executeAndPostResult = async (sql: string): Promise<void> => {
    const editableTarget = parseSimpleEditableSelectTarget(sql);
    const startedAt = Date.now();
    const result = await service.execute(sql);
    const durationMs = Date.now() - startedAt;
    let editable: QueryExecutionResultPayload["editable"] | undefined;

    if (editableTarget && result.rows.length > 0) {
      const ctidField = result.fields.some((field) => field.name === "__ctid__")
        ? "__ctid__"
        : undefined;

      if (ctidField) {
        const columns = await service.listColumns(
          editableTarget.schema,
          editableTarget.table,
        );
        const columnTypes: Record<string, string> = {};
        for (const column of columns) {
          columnTypes[column.name] = column.dataType.toLowerCase();
        }

        editable = {
          schema: editableTarget.schema,
          table: editableTarget.table,
          ctidField,
          columnTypes,
        };
      }
    }

    await panel.webview.postMessage({
      type: "result",
      payload: toQueryResultPayload(result, durationMs, editable),
    });
  };

  panel.webview.html = getQueryPanelHtml(
    connection.name,
    currentQuery?.sql ?? "",
    currentQuery?.name,
  );

  panel.webview.onDidReceiveMessage(async (message: unknown) => {
    const payload =
      typeof message === "object" && message !== null
        ? (message as {
            type?: string;
            payload?: {
              sql?: unknown;
              prefix?: unknown;
              tableQualifier?: unknown;
              schema?: unknown;
              table?: unknown;
              changes?: unknown;
            };
          })
        : undefined;

    if (!payload?.type) {
      return;
    }

    if (payload.type === "execute") {
      const rawSql =
        payload.payload && typeof payload.payload.sql === "string"
          ? payload.payload.sql
          : "";

      const editableTarget = parseSimpleEditableSelectTarget(rawSql);
      const sql = editableTarget ? ensureEditableCtidProjection(rawSql) : rawSql;

      if (!sql.trim()) {
        await panel.webview.postMessage({
          type: "status",
          ok: false,
          message: "Query is empty.",
        });
        return;
      }

      try {
        lastExecutedSql = sql;
        await executeAndPostResult(sql);
        await panel.webview.postMessage({
          type: "status",
          ok: true,
          message: "Query executed successfully.",
        });
      } catch (error) {
        await panel.webview.postMessage({
          type: "status",
          ok: false,
          message: getErrorMessage(error),
        });
      }

      return;
    }

    if (payload.type === "saveResultChanges") {
      const schema =
        typeof payload.payload?.schema === "string" ? payload.payload.schema : "";
      const table =
        typeof payload.payload?.table === "string" ? payload.payload.table : "";
      const changes = Array.isArray(payload.payload?.changes)
        ? (payload.payload?.changes as QueryResultChangeEntry[])
        : [];

      if (!schema || !table || changes.length === 0) {
        await panel.webview.postMessage({
          type: "status",
          ok: false,
          message: "No result changes to save.",
        });
        return;
      }

      if (service.isTransactionActive()) {
        await panel.webview.postMessage({
          type: "status",
          ok: false,
          message:
            "Wykryto już aktywną transakcję. Zakończ ją przed zapisem zmian z wyników.",
        });
        return;
      }

      try {
        await service.beginTransaction();
        for (const entry of changes) {
          await service.updateRowByCtid(schema, table, entry.ctid, entry.changes);
        }

        await service.commitTransaction();

        if (lastExecutedSql) {
          await executeAndPostResult(lastExecutedSql);
        }

        await panel.webview.postMessage({
          type: "status",
          ok: true,
          message: `Saved ${changes.length} changed rows (COMMIT).`,
        });
      } catch (error) {
        if (service.isTransactionActive()) {
          await service.rollbackTransaction();
        }

        await panel.webview.postMessage({
          type: "status",
          ok: false,
          message: `${getErrorMessage(error)} (ROLLBACK)`,
        });
      }

      return;
    }

    if (payload.type === "autocomplete") {
      try {
        const requestPayload: AutocompleteRequestPayload = {
          prefix:
            typeof payload.payload?.prefix === "string"
              ? payload.payload.prefix
              : "",
          tableQualifier:
            typeof payload.payload?.tableQualifier === "string"
              ? payload.payload.tableQualifier
              : undefined,
        };

        const metadata = await getAutocompleteMetadata();
        const suggestions = buildAutocompleteSuggestions(metadata, requestPayload);

        await panel.webview.postMessage({
          type: "autocompleteSuggestions",
          payload: suggestions,
        });
      } catch {
        await panel.webview.postMessage({
          type: "autocompleteSuggestions",
          payload: [],
        });
      }

      return;
    }

    if (payload.type === "saveQuery") {
      const sql =
        payload.payload && typeof payload.payload.sql === "string"
          ? payload.payload.sql.trim()
          : "";

      if (!sql) {
        await panel.webview.postMessage({
          type: "status",
          ok: false,
          message: "Cannot save empty query.",
        });
        return;
      }

      const defaultName =
        currentQuery?.name ||
        sql.split("\n")[0].slice(0, 60).trim() ||
        "Saved query";
      const name = await vscode.window.showInputBox({
        title: `Save query (${connection.name})`,
        prompt: "Saved query name",
        value: defaultName,
        ignoreFocusOut: true,
      });

      if (!name || !name.trim()) {
        await panel.webview.postMessage({
          type: "status",
          ok: false,
          message: "Save canceled.",
        });
        return;
      }

      const nowIso = new Date().toISOString();
      const existing = readQueries();
      let nextQueries: SavedSqlQuery[];
      let savedQueryName = name.trim();

      if (currentQuery) {
        let foundCurrent = false;
        nextQueries = existing.map((item) =>
          item.id === currentQuery!.id
            ? ((foundCurrent = true),
              {
                ...item,
                name: savedQueryName,
                sql,
                updatedAt: nowIso,
              })
            : item,
        );

        if (foundCurrent) {
          currentQuery = nextQueries.find(
            (item) => item.id === currentQuery!.id,
          );
        } else {
          const recreatedQuery: SavedSqlQuery = {
            id: createConnectionId(),
            name: savedQueryName,
            sql,
            createdAt: nowIso,
            updatedAt: nowIso,
          };
          nextQueries = [recreatedQuery, ...nextQueries].slice(0, 100);
          currentQuery = recreatedQuery;
        }
      } else {
        const newQuery: SavedSqlQuery = {
          id: createConnectionId(),
          name: savedQueryName,
          sql,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        nextQueries = [newQuery, ...existing].slice(0, 100);
        currentQuery = newQuery;
      }

      await saveSqlQueries(context, connection.id, nextQueries);
      onQueriesChanged();

      panel.title = currentQuery
        ? `SQL: ${connection.name} / ${currentQuery.name}`
        : `SQL: ${connection.name}`;

      await panel.webview.postMessage({
        type: "status",
        ok: true,
        message: `Saved query: ${savedQueryName}`,
      });
      return;
    }
  });
}

function getEditableTableHtml(
  schema: string,
  table: string,
  data: EditableTableData,
  searchQuery = "",
): string {
  const payload = JSON.stringify({ schema, table, searchQuery, ...data }).replace(
    /</g,
    "\\u003c",
  );

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Table Editor</title>
  <style>
    body {
      margin: 0;
      padding: 14px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .toolbar {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      padding: 8px 0;
      background: var(--vscode-editor-background);
    }
    .title {
      font-size: 14px;
      font-weight: 600;
    }
    .status {
      font-size: 12px;
      min-height: 16px;
    }
    .search-row {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      margin: 8px 0;
    }
    .search-row input {
      min-width: 280px;
      flex: 1;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 6px;
      padding: 7px 10px;
      outline: none;
    }
    .search-row input:focus {
      border-color: var(--vscode-focusBorder);
    }
    #limitInput {
      min-width: 110px;
      width: 110px;
      flex: 0 0 auto;
    }
    .meta {
      font-size: 12px;
      opacity: 0.9;
      margin-bottom: 8px;
      min-height: 16px;
    }
    .status.ok {
      color: var(--vscode-testing-iconPassed);
    }
    .status.error {
      color: var(--vscode-testing-iconFailed);
    }
    button {
      border: 1px solid var(--vscode-button-border);
      border-radius: 6px;
      padding: 7px 12px;
      cursor: pointer;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    .table-wrap {
      overflow: auto;
      max-height: calc(100vh - 110px);
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 8px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 860px;
      table-layout: fixed;
    }
    th, td {
      border-bottom: 1px solid var(--vscode-editorWidget-border);
      padding: 0;
      text-align: left;
      vertical-align: middle;
      overflow: hidden;
    }
    th {
      position: relative;
      position: sticky;
      top: 0;
      z-index: 1;
      background: var(--vscode-sideBar-background);
      padding: 8px 10px;
      font-size: 12px;
    }
    .th-label {
      display: block;
      padding-right: 10px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .column-resizer {
      position: absolute;
      top: 0;
      right: 0;
      width: 8px;
      height: 100%;
      cursor: col-resize;
      user-select: none;
    }
    .column-resizer:hover {
      background: var(--vscode-focusBorder);
      opacity: 0.5;
    }
    .cell {
      display: block;
    }
    td input {
      width: 100%;
      border: none;
      outline: none;
      background: transparent;
      color: var(--vscode-input-foreground);
      padding: 8px 10px;
      font-size: 12px;
      box-sizing: border-box;
    }
    td input.changed {
      background: #1f4f2d55;
    }
    td input.readonly {
      opacity: 0.9;
      cursor: pointer;
    }
    .empty {
      padding: 14px;
      font-size: 12px;
      opacity: 0.85;
    }
    .modal {
      position: fixed;
      inset: 0;
      background: #00000066;
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 10;
    }
    .modal.visible {
      display: flex;
    }
    .modal-body {
      width: min(760px, 90vw);
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 10px;
      padding: 14px;
      display: grid;
      gap: 10px;
    }
    .modal-title {
      font-size: 13px;
      font-weight: 600;
    }
    .modal-input,
    .modal-textarea {
      width: 100%;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 6px;
      padding: 8px;
      font-family: var(--vscode-font-family);
      box-sizing: border-box;
    }
    .modal-textarea {
      min-height: 260px;
      resize: vertical;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .modal-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }
    .modal-error {
      min-height: 16px;
      font-size: 12px;
      color: var(--vscode-testing-iconFailed);
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div class="title" id="title"></div>
    <button id="saveChanges" type="button">Save Changes</button>
  </div>
  <div class="search-row">
    <input id="searchInput" type="text" placeholder="Search in all columns..." />
    <input id="limitInput" type="number" min="1" max="1000" step="1" placeholder="Limit" />
    <button id="applyLimitButton" type="button">Load rows</button>
    <button id="searchButton" type="button">Search</button>
    <button id="clearSearchButton" type="button">Clear</button>
  </div>
  <div id="meta" class="meta"></div>
  <div id="status" class="status"></div>
  <div id="tableWrap" class="table-wrap"></div>

  <div id="cellModal" class="modal" role="dialog" aria-modal="true">
    <div class="modal-body">
      <div id="cellModalTitle" class="modal-title"></div>
      <input id="cellModalInput" class="modal-input" />
      <textarea id="cellModalTextarea" class="modal-textarea"></textarea>
      <div id="cellModalError" class="modal-error"></div>
      <div class="modal-actions">
        <button id="cellModalCancel" type="button">Cancel</button>
        <button id="cellModalSave" type="button">Apply</button>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let state = ${payload};
    const changesByRow = new Map();
    let rowsByCtid = new Map(state.rows.map((row) => [row.ctid, row]));
    const columnWidths = {};
    const MIN_COLUMN_WIDTH = 120;

    const title = document.getElementById("title");
    const meta = document.getElementById("meta");
    const status = document.getElementById("status");
    const tableWrap = document.getElementById("tableWrap");
    const saveButton = document.getElementById("saveChanges");
    const searchInput = document.getElementById("searchInput");
    const limitInput = document.getElementById("limitInput");
    const applyLimitButton = document.getElementById("applyLimitButton");
    const searchButton = document.getElementById("searchButton");
    const clearSearchButton = document.getElementById("clearSearchButton");

    const modal = document.getElementById("cellModal");
    const modalTitle = document.getElementById("cellModalTitle");
    const modalInput = document.getElementById("cellModalInput");
    const modalTextarea = document.getElementById("cellModalTextarea");
    const modalError = document.getElementById("cellModalError");
    const modalCancel = document.getElementById("cellModalCancel");
    const modalSave = document.getElementById("cellModalSave");

    let currentModalContext = null;

    const numericTypes = new Set([
      "smallint",
      "integer",
      "bigint",
      "decimal",
      "numeric",
      "real",
      "double precision",
      "smallserial",
      "serial",
      "bigserial"
    ]);

    function getColumnType(column) {
      return String((state.columnTypes && state.columnTypes[column]) || "").toLowerCase();
    }

    function isJsonType(column) {
      const type = getColumnType(column);
      return type === "json" || type === "jsonb";
    }

    function serializeCell(value, column) {
      if (value === null || value === undefined) {
        return "";
      }

      if (isJsonType(column)) {
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      }

      if (typeof value === "object") {
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      }

      return String(value);
    }

    function setStatus(message, ok) {
      status.textContent = message;
      status.className = ok ? "status ok" : "status error";
    }

    function markChanged(ctid, column, input) {
      const isChanged = input.value !== input.dataset.original;
      input.classList.toggle("changed", isChanged);

      const existing = changesByRow.get(ctid) || {};
      if (isChanged) {
        existing[column] = input.value;
        changesByRow.set(ctid, existing);
      } else {
        delete existing[column];
        if (Object.keys(existing).length === 0) {
          changesByRow.delete(ctid);
        } else {
          changesByRow.set(ctid, existing);
        }
      }
    }

    function openCellModal(ctid, column, input) {
      currentModalContext = { ctid, column, input };
      modalError.textContent = "";

      const useJsonEditor = isJsonType(column);
      modalTitle.textContent = useJsonEditor
        ? "Edit JSON: " + column
        : "Edit value: " + column;

      if (useJsonEditor) {
        modalInput.style.display = "none";
        modalTextarea.style.display = "block";

        try {
          const parsed = input.value.trim() ? JSON.parse(input.value) : null;
          modalTextarea.value = parsed === null ? "" : JSON.stringify(parsed, null, 2);
        } catch {
          modalTextarea.value = input.value;
        }

        modalTextarea.focus();
      } else {
        modalTextarea.style.display = "none";
        modalInput.style.display = "block";
        modalInput.value = input.value;
        modalInput.focus();
        modalInput.select();
      }

      modal.classList.add("visible");
    }

    function closeCellModal() {
      currentModalContext = null;
      modal.classList.remove("visible");
    }

    function convertForSave(rawValue, column, originalValue) {
      const type = getColumnType(column);
      const trimmed = String(rawValue).trim();

      if (trimmed === "" && originalValue === null) {
        return null;
      }

      if (type === "boolean") {
        if (trimmed === "" && originalValue === null) {
          return null;
        }

        const normalized = trimmed.toLowerCase();
        if (normalized === "true" || normalized === "1") {
          return true;
        }
        if (normalized === "false" || normalized === "0") {
          return false;
        }
        throw new Error("Column " + column + ": expected boolean (true/false).");
      }

      if (numericTypes.has(type)) {
        if (trimmed === "") {
          return null;
        }

        const numeric = Number(trimmed);
        if (Number.isNaN(numeric)) {
          throw new Error("Column " + column + ": expected number.");
        }
        return numeric;
      }

      if (type === "json" || type === "jsonb") {
        if (trimmed === "") {
          return null;
        }

        try {
          return JSON.parse(rawValue);
        } catch {
          throw new Error("Column " + column + ": invalid JSON.");
        }
      }

      return rawValue;
    }

    function normalizeChangePayload() {
      const payload = {};
      for (const [ctid, rowChanges] of changesByRow.entries()) {
        const originalRow = rowsByCtid.get(ctid);
        const typedChanges = {};

        for (const [column, rawValue] of Object.entries(rowChanges)) {
          const originalValue = originalRow ? originalRow.data[column] : null;
          typedChanges[column] = convertForSave(rawValue, column, originalValue);
        }

        payload[ctid] = typedChanges;
      }
      return payload;
    }

    function setColumnWidth(column, width) {
      const safeWidth = Math.max(MIN_COLUMN_WIDTH, Math.floor(width));
      columnWidths[column] = safeWidth;

      const nodes = tableWrap.querySelectorAll("[data-column-key]");
      for (const node of nodes) {
        if (node.dataset.columnKey !== column) {
          continue;
        }

        node.style.width = safeWidth + "px";
        node.style.minWidth = safeWidth + "px";
        node.style.maxWidth = safeWidth + "px";
      }
    }

    function startResize(event, column, currentWidth) {
      event.preventDefault();
      const startX = event.clientX;

      function onMouseMove(moveEvent) {
        const delta = moveEvent.clientX - startX;
        setColumnWidth(column, currentWidth + delta);
      }

      function onMouseUp() {
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
      }

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    }

    function render() {
      title.textContent = state.schema + "." + state.table;
      searchInput.value = state.searchQuery || "";
      limitInput.value = String(Number(state.limit || 100));

      const shownRows = state.rows.length;
      const matchedRows = Number(state.matchedRows || 0);
      const totalRows = Number(state.totalRows || 0);
      const currentLimit = Number(state.limit || 100);
      const isFiltered = (state.searchQuery || "").trim().length > 0;
      const scopeLabel = isFiltered
        ? "matching filter"
        : "from table";

      meta.textContent =
        "Showing " + shownRows + " of " + matchedRows + " " + scopeLabel +
        " (total in table: " + totalRows + ", limit: " + currentLimit + ")";

      if (!state.rows.length) {
        tableWrap.innerHTML = '<div class="empty">No rows found for the current filter.</div>';
        saveButton.disabled = true;
        return;
      }

      const tableElement = document.createElement("table");
      const head = document.createElement("thead");
      const headRow = document.createElement("tr");
      for (const column of state.columns) {
        if (!columnWidths[column]) {
          columnWidths[column] = Math.max(MIN_COLUMN_WIDTH, Math.min(320, column.length * 12));
        }

        const th = document.createElement("th");
        th.dataset.columnKey = column;

        const label = document.createElement("span");
        label.className = "th-label";
        label.textContent = column;

        const resizer = document.createElement("span");
        resizer.className = "column-resizer";
        resizer.title = "Resize column";
        resizer.addEventListener("mousedown", (event) => {
          startResize(event, column, columnWidths[column]);
        });

        th.appendChild(label);
        th.appendChild(resizer);
        headRow.appendChild(th);
      }
      head.appendChild(headRow);
      tableElement.appendChild(head);

      const body = document.createElement("tbody");
      for (const row of state.rows) {
        const tr = document.createElement("tr");

        for (const column of state.columns) {
          const td = document.createElement("td");
          td.dataset.columnKey = column;
          const wrapper = document.createElement("div");
          wrapper.className = "cell";

          const input = document.createElement("input");
          const originalValue = serializeCell(row.data[column], column);
          input.value = originalValue;
          input.dataset.original = originalValue;
          input.dataset.column = column;

          // We use modal editing for all cell types to keep interactions consistent.
          input.readOnly = true;
          input.classList.add("readonly");

          input.addEventListener("click", () => {
            openCellModal(row.ctid, column, input);
          });

          wrapper.appendChild(input);
          td.appendChild(wrapper);
          tr.appendChild(td);
        }

        body.appendChild(tr);
      }

      tableElement.appendChild(body);
      tableWrap.innerHTML = "";
      tableWrap.appendChild(tableElement);

      for (const column of state.columns) {
        setColumnWidth(column, columnWidths[column]);
      }

      saveButton.disabled = false;
    }

    function hasUnsavedChanges() {
      return changesByRow.size > 0;
    }

    function parseRequestedLimit() {
      const parsed = Number(limitInput.value);
      if (!Number.isFinite(parsed)) {
        return null;
      }

      const normalized = Math.floor(parsed);
      if (normalized < 1 || normalized > 1000) {
        return null;
      }

      return normalized;
    }

    function requestSearch(nextQuery, nextLimit, loadingMessage) {
      if (hasUnsavedChanges()) {
        setStatus("Save or discard current changes before searching.", false);
        return;
      }

      const requestedLimit = typeof nextLimit === "number"
        ? nextLimit
        : parseRequestedLimit();
      if (!requestedLimit) {
        setStatus("Limit must be a number between 1 and 1000.", false);
        return;
      }

      applyLimitButton.disabled = true;
      searchButton.disabled = true;
      clearSearchButton.disabled = true;
      setStatus(loadingMessage || "Loading rows...", true);
      vscode.postMessage({
        type: "search",
        payload: { query: nextQuery, limit: requestedLimit },
      });
    }

    modalCancel.addEventListener("click", () => {
      closeCellModal();
    });

    modalSave.addEventListener("click", () => {
      if (!currentModalContext) {
        return;
      }

      const { ctid, column, input } = currentModalContext;
      const isJson = isJsonType(column);
      const newValue = isJson ? modalTextarea.value : modalInput.value;

      if (isJson && newValue.trim() !== "") {
        try {
          const parsed = JSON.parse(newValue);
          input.value = JSON.stringify(parsed);
        } catch {
          modalError.textContent = "Invalid JSON format.";
          return;
        }
      } else {
        input.value = newValue;
      }

      markChanged(ctid, column, input);
      closeCellModal();
    });

    saveButton.addEventListener("click", () => {
      let payload;
      try {
        payload = normalizeChangePayload();
      } catch (error) {
        setStatus(String(error instanceof Error ? error.message : error), false);
        return;
      }

      const changeCount = Object.keys(payload).length;
      if (changeCount === 0) {
        setStatus("Brak zmian do zapisania.", false);
        return;
      }

      saveButton.disabled = true;
      setStatus("Zapisywanie zmian...", true);
      vscode.postMessage({ type: "saveChanges", payload });
    });

    searchButton.addEventListener("click", () => {
      requestSearch(searchInput.value, undefined, "Loading filtered rows...");
    });

    clearSearchButton.addEventListener("click", () => {
      if (!searchInput.value.trim() && !(state.searchQuery || "").trim()) {
        return;
      }

      searchInput.value = "";
      requestSearch("", undefined, "Loading rows...");
    });

    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        requestSearch(searchInput.value, undefined, "Loading filtered rows...");
      }
    });

    applyLimitButton.addEventListener("click", () => {
      const requestedLimit = parseRequestedLimit();
      if (!requestedLimit) {
        setStatus("Limit must be a number between 1 and 1000.", false);
        return;
      }

      const currentLimit = Number(state.limit || 100);
      const query = searchInput.value;
      const message = requestedLimit > currentLimit
        ? "Loading missing rows..."
        : "Refreshing rows...";

      requestSearch(query, requestedLimit, message);
    });

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (!msg) {
        return;
      }

      if (msg.type === "refreshData") {
        applyLimitButton.disabled = false;
        searchButton.disabled = false;
        clearSearchButton.disabled = false;
        state = {
          ...state,
          ...msg.payload,
          searchQuery: msg.query || "",
        };
        rowsByCtid = new Map(state.rows.map((row) => [row.ctid, row]));
        changesByRow.clear();
        setStatus("Rows loaded.", true);
        render();
        return;
      }

      if (msg.type !== "saveResult") {
        return;
      }

      saveButton.disabled = false;
      setStatus(msg.message, Boolean(msg.ok));

      if (!msg.ok) {
        return;
      }

      changesByRow.clear();
      const inputs = tableWrap.querySelectorAll("input[data-original]");
      for (const input of inputs) {
        input.dataset.original = input.value;
        input.classList.remove("changed");
      }
    });

    render();
  </script>
</body>
</html>`;
}

async function openEditableTablePanel(
  service: PostgresService,
  schema: string,
  table: string,
  tableData: EditableTableData,
  onSaved: () => void,
): Promise<void> {
  let currentSearch = "";
  let currentLimit = Math.max(1, Math.min(1000, Math.floor(tableData.limit || 100)));

  const panel = vscode.window.createWebviewPanel(
    "postgresPlugin.tableEditor",
    `Table: ${schema}.${table}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );

  panel.webview.html = getEditableTableHtml(
    schema,
    table,
    {
      ...tableData,
      limit: currentLimit,
    },
    currentSearch,
  );

  panel.webview.onDidReceiveMessage(async (message: unknown) => {
    const payload =
      typeof message === "object" && message !== null
        ? (message as {
            type?: string;
            payload?:
              | Record<string, Record<string, unknown>>
              | { query?: string; limit?: number };
          })
        : undefined;

    if (payload?.type === "search") {
      const queryPayload =
        payload.payload && typeof payload.payload === "object"
          ? (payload.payload as { query?: unknown; limit?: unknown })
          : undefined;

      currentSearch =
        typeof queryPayload?.query === "string" ? queryPayload.query : "";
      const requestedLimit =
        typeof queryPayload?.limit === "number" && Number.isFinite(queryPayload.limit)
          ? Math.floor(queryPayload.limit)
          : currentLimit;
      currentLimit = Math.max(1, Math.min(1000, requestedLimit));

      try {
        const nextData = await service.previewRowsForEditor(
          schema,
          table,
          currentLimit,
          currentSearch,
        );

        await panel.webview.postMessage({
          type: "refreshData",
          query: currentSearch,
          payload: nextData,
        });
      } catch (error) {
        await panel.webview.postMessage({
          type: "saveResult",
          ok: false,
          message: `Search error: ${getErrorMessage(error)}`,
        });
      }

      return;
    }

    if (payload?.type !== "saveChanges") {
      return;
    }

    const changes = payload.payload ?? {};
    const entries = Object.entries(changes);

    if (entries.length === 0) {
      await panel.webview.postMessage({
        type: "saveResult",
        ok: false,
        message: "Brak zmian do zapisania.",
      });
      return;
    }

    if (service.isTransactionActive()) {
      await panel.webview.postMessage({
        type: "saveResult",
        ok: false,
        message:
          "Wykryto już aktywną transakcję. Zakończ ją przed zapisem zmian z tabeli.",
      });
      return;
    }

    try {
      await service.beginTransaction();

      for (const [ctid, rowChanges] of entries) {
        await service.updateRowByCtid(schema, table, ctid, rowChanges);
      }

      await service.commitTransaction();
      onSaved();

      const refreshedData = await service.previewRowsForEditor(
        schema,
        table,
        currentLimit,
        currentSearch,
      );
      await panel.webview.postMessage({
        type: "refreshData",
        query: currentSearch,
        payload: refreshedData,
      });

      await panel.webview.postMessage({
        type: "saveResult",
        ok: true,
        message: `Zapisano ${entries.length} zmienionych wierszy (COMMIT).`,
      });
    } catch (error) {
      if (service.isTransactionActive()) {
        await service.rollbackTransaction();
      }

      await panel.webview.postMessage({
        type: "saveResult",
        ok: false,
        message: `${getErrorMessage(error)} (ROLLBACK)`,
      });
    }
  });
}

async function showRowsAsJson(title: string, rows: unknown[]): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    language: "json",
    content: JSON.stringify(
      {
        title,
        rows,
        rowCount: rows.length,
      },
      null,
      2,
    ),
  });

  await vscode.window.showTextDocument(doc, { preview: false });
}

async function selectSavedConnection(
  context: vscode.ExtensionContext,
  nodeOrItem?: unknown,
): Promise<SavedConnection | undefined> {
  const connections = getSavedConnections(context);
  if (connections.length === 0) {
    return undefined;
  }

  const directConnectionId = (() => {
    if (!nodeOrItem || typeof nodeOrItem !== "object") {
      return undefined;
    }

    const maybeNode = nodeOrItem as { connectionId?: unknown };
    if (typeof maybeNode.connectionId === "string") {
      return maybeNode.connectionId;
    }

    const maybeItem = nodeOrItem as {
      node?: { connectionId?: unknown };
    };
    if (
      maybeItem.node &&
      typeof maybeItem.node === "object" &&
      typeof maybeItem.node.connectionId === "string"
    ) {
      return maybeItem.node.connectionId;
    }

    return undefined;
  })();

  if (directConnectionId) {
    const fromNode = connections.find(
      (connection) => connection.id === directConnectionId,
    );
    if (fromNode) {
      return fromNode;
    }
  }

  const choice = await vscode.window.showQuickPick(
    connections.map((connection) => ({
      label: connection.name,
      description: `${connection.user}@${connection.host}:${connection.port}/${connection.database}`,
      connection,
    })),
    {
      title: "Wybierz zapisane połączenie",
    },
  );

  return choice?.connection;
}

export function activate(context: vscode.ExtensionContext): void {
  const service = new PostgresService();
  let activeConnectionId: string | undefined;

  const refreshMenuContext = async (): Promise<void> => {
    const hasConnections = getSavedConnections(context).length > 0;
    await vscode.commands.executeCommand(
      "setContext",
      "postgresPlugin.hasConnections",
      hasConnections,
    );
    await vscode.commands.executeCommand(
      "setContext",
      "postgresPlugin.connected",
      Boolean(activeConnectionId),
    );
  };

  const provider = new PostgresTreeDataProvider(
    service,
    () => getSavedConnections(context),
    () => activeConnectionId,
    (connectionId) => getSavedQueriesForTree(context, connectionId),
  );

  const ensureConnectedTo = async (
    connection: SavedConnection,
  ): Promise<boolean> => {
    if (service.isConnected() && activeConnectionId === connection.id) {
      return true;
    }

    const config = await toConnectionConfig(context, connection);
    if (!config) {
      return false;
    }

    await service.connect(config);
    activeConnectionId = connection.id;
    await refreshMenuContext();
    provider.refresh();
    return true;
  };

  void refreshMenuContext();

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("postgresPlugin.explorer", provider),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "postgresPlugin.createConnection",
      async () => {
        try {
          const form = await openConnectionFormPanel({
            title: "Create PostgreSQL Connection",
          });
          if (!form) {
            return;
          }

          const newConnection: SavedConnection = {
            id: createConnectionId(),
            name: form.name,
            host: form.host,
            port: form.port,
            database: form.database,
            user: form.user,
            ssl: form.ssl,
          };

          const current = getSavedConnections(context);
          current.push(newConnection);
          await saveConnections(context, current);
          await context.secrets.store(
            `${PASSWORD_KEY_PREFIX}${newConnection.id}`,
            form.password,
          );

          await refreshMenuContext();
          provider.refresh();
          vscode.window.showInformationMessage(
            `Connection saved: ${newConnection.name}`,
          );
        } catch (error) {
          vscode.window.showErrorMessage(
            `Create connection error: ${getErrorMessage(error)}`,
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "postgresPlugin.editConnection",
      async (node?: ExplorerNode) => {
        try {
          const selected = await selectSavedConnection(context, node);
          if (!selected) {
            vscode.window.showWarningMessage("Brak zapisanych połączeń.");
            return;
          }

          const existingPassword =
            (await context.secrets.get(
              `${PASSWORD_KEY_PREFIX}${selected.id}`,
            )) ?? "";

          const form = await openConnectionFormPanel({
            title: "Edit PostgreSQL Connection",
            defaults: {
              name: selected.name,
              host: selected.host,
              port: selected.port,
              database: selected.database,
              user: selected.user,
              ssl: selected.ssl,
              password: existingPassword,
            },
          });
          if (!form) {
            return;
          }

          const connections = getSavedConnections(context);
          const index = connections.findIndex(
            (connection) => connection.id === selected.id,
          );
          if (index < 0) {
            vscode.window.showErrorMessage(
              "Nie udało się odnaleźć połączenia do edycji.",
            );
            return;
          }

          connections[index] = {
            id: selected.id,
            name: form.name,
            host: form.host,
            port: form.port,
            database: form.database,
            user: form.user,
            ssl: form.ssl,
          };

          await saveConnections(context, connections);
          await context.secrets.store(
            `${PASSWORD_KEY_PREFIX}${selected.id}`,
            form.password,
          );

          await refreshMenuContext();
          provider.refresh();
          vscode.window.showInformationMessage(
            `Connection updated: ${form.name}`,
          );
        } catch (error) {
          vscode.window.showErrorMessage(
            `Edit connection error: ${getErrorMessage(error)}`,
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "postgresPlugin.deleteConnection",
      async (node?: ExplorerNode) => {
        try {
          const selected = await selectSavedConnection(context, node);
          if (!selected) {
            vscode.window.showWarningMessage("Brak zapisanych połączeń.");
            return;
          }

          const confirmation = await vscode.window.showWarningMessage(
            `Usunąć połączenie ${selected.name}?`,
            { modal: true },
            "Delete",
          );

          if (confirmation !== "Delete") {
            return;
          }

          const connections = getSavedConnections(context).filter(
            (connection) => connection.id !== selected.id,
          );
          await saveConnections(context, connections);
          await context.secrets.delete(`${PASSWORD_KEY_PREFIX}${selected.id}`);
          await context.globalState.update(
            `${SAVED_QUERIES_KEY_PREFIX}${selected.id}`,
            undefined,
          );

          if (activeConnectionId === selected.id) {
            await service.disconnect();
            activeConnectionId = undefined;
          }

          await refreshMenuContext();
          provider.refresh();
          vscode.window.showInformationMessage(
            `Connection deleted: ${selected.name}`,
          );
        } catch (error) {
          vscode.window.showErrorMessage(
            `Delete connection error: ${getErrorMessage(error)}`,
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "postgresPlugin.connectSaved",
      async (node?: ExplorerNode) => {
        try {
          const selected = await selectSavedConnection(context, node);
          if (!selected) {
            vscode.window.showWarningMessage(
              "Brak zapisanych połączeń. Użyj Create Connection.",
            );
            return;
          }

          const config = await toConnectionConfig(context, selected);
          if (!config) {
            return;
          }

          const connectingStatus = vscode.window.setStatusBarMessage(
            `Connecting to ${selected.name}...`,
          );

          try {
            await service.connect(config);
            activeConnectionId = selected.id;
            await refreshMenuContext();
            provider.refresh();
            vscode.window.setStatusBarMessage(
              `PostgreSQL connected: ${selected.name}`,
              3000,
            );
          } finally {
            connectingStatus.dispose();
          }
        } catch (error) {
          vscode.window.showErrorMessage(
            `PostgreSQL connect error: ${getErrorMessage(error)}`,
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("postgresPlugin.connect", async () => {
      try {
        const connections = getSavedConnections(context);
        if (connections.length === 0) {
          const createNew = await vscode.window.showInformationMessage(
            "Brak zapisanych połączeń. Czy chcesz utworzyć nowe?",
            "Create Connection",
          );

          if (createNew === "Create Connection") {
            await vscode.commands.executeCommand(
              "postgresPlugin.createConnection",
            );
          }

          return;
        }

        await vscode.commands.executeCommand("postgresPlugin.connectSaved");
      } catch (error) {
        vscode.window.showErrorMessage(
          `PostgreSQL connect error: ${getErrorMessage(error)}`,
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("postgresPlugin.disconnect", async () => {
      try {
        await service.disconnect();
        activeConnectionId = undefined;
        await refreshMenuContext();
        provider.refresh();
        vscode.window.showInformationMessage("PostgreSQL disconnected.");
      } catch (error) {
        vscode.window.showErrorMessage(
          `PostgreSQL disconnect error: ${getErrorMessage(error)}`,
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("postgresPlugin.refreshExplorer", () => {
      provider.refresh();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "postgresPlugin.previewTable",
      async (node?: ExplorerNode) => {
        try {
          if (!service.isConnected()) {
            vscode.window.showWarningMessage(
              "Najpierw połącz się z bazą danych.",
            );
            return;
          }

          let schema = node?.schema;
          let table = node?.table;

          if (!schema || !table) {
            const name = await vscode.window.showInputBox({
              prompt: "Podaj nazwę tabeli jako schema.table",
              placeHolder: "public.users",
            });

            if (!name) {
              return;
            }

            const [schemaName, tableName] = name.split(".");
            schema = schemaName;
            table = tableName;
          }

          if (!schema || !table) {
            vscode.window.showErrorMessage(
              "Niepoprawny format nazwy tabeli (oczekiwano schema.table).",
            );
            return;
          }

          const tableData = await service.previewRowsForEditor(
            schema,
            table,
            100,
            "",
          );
          await openEditableTablePanel(service, schema, table, tableData, () =>
            provider.refresh(),
          );
        } catch (error) {
          vscode.window.showErrorMessage(
            `PostgreSQL preview error: ${getErrorMessage(error)}`,
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "postgresPlugin.openQueryPanel",
      async (node?: ExplorerNode) => {
        try {
          const selectedQuery = getSavedQueryFromNode(context, node);
          if (selectedQuery) {
            const connection = getSavedConnections(context).find(
              (item) => item.id === selectedQuery.connectionId,
            );

            if (!connection) {
              vscode.window.showErrorMessage(
                "Nie znaleziono połączenia dla zapisanego zapytania.",
              );
              return;
            }

            const connected = await ensureConnectedTo(connection);
            if (!connected) {
              return;
            }

            await openQueryPanel(
              context,
              service,
              connection,
              () => provider.refresh(),
              {
                initialQuery: selectedQuery.query,
              },
            );
            return;
          }

          let selected: SavedConnection | undefined;
          if (node) {
            selected = await selectSavedConnection(context, node);
          } else {
            selected = getSavedConnections(context).find(
              (connection) => connection.id === activeConnectionId,
            );

            if (!selected) {
              selected = await selectSavedConnection(context);
            }
          }

          if (!selected) {
            vscode.window.showWarningMessage(
              "Brak zapisanych połączeń. Użyj Create Connection.",
            );
            return;
          }

          const connected = await ensureConnectedTo(selected);
          if (!connected) {
            return;
          }

          await openQueryPanel(context, service, selected, () =>
            provider.refresh(),
          );
        } catch (error) {
          vscode.window.showErrorMessage(
            `PostgreSQL SQL error: ${getErrorMessage(error)}`,
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "postgresPlugin.renameSavedQuery",
      async (node?: ExplorerNode) => {
        try {
          const selected = getSavedQueryFromNode(context, node);
          if (!selected) {
            vscode.window.showWarningMessage(
              "Wybierz zapisane zapytanie do zmiany nazwy.",
            );
            return;
          }

          const nextName = await vscode.window.showInputBox({
            title: "Rename saved query",
            prompt: "New query name",
            value: selected.query.name,
            ignoreFocusOut: true,
          });

          if (!nextName || !nextName.trim()) {
            return;
          }

          const nowIso = new Date().toISOString();
          const queries = getSavedSqlQueries(
            context,
            selected.connectionId,
          ).map((item) =>
            item.id === selected.query.id
              ? { ...item, name: nextName.trim(), updatedAt: nowIso }
              : item,
          );

          await saveSqlQueries(context, selected.connectionId, queries);
          provider.refresh();
          vscode.window.showInformationMessage(
            `Query renamed: ${nextName.trim()}`,
          );
        } catch (error) {
          vscode.window.showErrorMessage(
            `Rename query error: ${getErrorMessage(error)}`,
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "postgresPlugin.deleteSavedQuery",
      async (node?: ExplorerNode) => {
        try {
          const selected = getSavedQueryFromNode(context, node);
          if (!selected) {
            vscode.window.showWarningMessage(
              "Wybierz zapisane zapytanie do usunięcia.",
            );
            return;
          }

          const confirmation = await vscode.window.showWarningMessage(
            `Usunąć zapytanie ${selected.query.name}?`,
            { modal: true },
            "Delete",
          );

          if (confirmation !== "Delete") {
            return;
          }

          const queries = getSavedSqlQueries(
            context,
            selected.connectionId,
          ).filter((item) => item.id !== selected.query.id);

          await saveSqlQueries(context, selected.connectionId, queries);
          provider.refresh();
          vscode.window.showInformationMessage(
            `Deleted query: ${selected.query.name}`,
          );
        } catch (error) {
          vscode.window.showErrorMessage(
            `Delete query error: ${getErrorMessage(error)}`,
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("postgresPlugin.executeSql", async () => {
      try {
        if (!service.isConnected()) {
          await vscode.commands.executeCommand("postgresPlugin.openQueryPanel");
        } else {
          const currentConnection = getSavedConnections(context).find(
            (connection) => connection.id === activeConnectionId,
          );

          if (!currentConnection) {
            await vscode.commands.executeCommand("postgresPlugin.openQueryPanel");
            return;
          }

          await openQueryPanel(context, service, currentConnection, () =>
            provider.refresh(),
          );
        }
      } catch (error) {
        vscode.window.showErrorMessage(
          `PostgreSQL SQL error: ${getErrorMessage(error)}`,
        );
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "postgresPlugin.beginTransaction",
      async () => {
        try {
          await service.beginTransaction();
          vscode.window.showInformationMessage(
            "Transakcja rozpoczęta. Zmiany będą zatwierdzone dopiero po Commit.",
          );
        } catch (error) {
          vscode.window.showErrorMessage(
            `PostgreSQL transaction error: ${getErrorMessage(error)}`,
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "postgresPlugin.commitTransaction",
      async () => {
        try {
          await service.commitTransaction();
          await refreshMenuContext();
          provider.refresh();
          vscode.window.showInformationMessage(
            "Transakcja zatwierdzona (COMMIT).",
          );
        } catch (error) {
          vscode.window.showErrorMessage(
            `PostgreSQL transaction error: ${getErrorMessage(error)}`,
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "postgresPlugin.rollbackTransaction",
      async () => {
        try {
          await service.rollbackTransaction();
          await refreshMenuContext();
          provider.refresh();
          vscode.window.showInformationMessage(
            "Transakcja wycofana (ROLLBACK).",
          );
        } catch (error) {
          vscode.window.showErrorMessage(
            `PostgreSQL transaction error: ${getErrorMessage(error)}`,
          );
        }
      },
    ),
  );

  context.subscriptions.push({
    dispose: () => {
      activeConnectionId = undefined;
      void refreshMenuContext();
      void service.disconnect();
    },
  });
}

export function deactivate(): void {
  // No-op; cleanup is handled by disposable in activate.
}
