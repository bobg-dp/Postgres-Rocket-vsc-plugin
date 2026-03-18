import * as vscode from "vscode";
import {
  DbColumn,
  DbSchema,
  DbTable,
  PostgresService,
} from "./postgresService";

export type NodeType =
  | "info"
  | "connection"
  | "savedQueriesFolder"
  | "savedQuery"
  | "schema"
  | "table"
  | "column";

export interface SavedQueryTreeItem {
  id: string;
  name: string;
  updatedAt?: string;
}

export interface SavedConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: boolean;
}

export interface ExplorerNode {
  type: NodeType;
  label: string;
  connectionId?: string;
  schema?: string;
  table?: string;
  queryId?: string;
  description?: string;
}

export class ExplorerItem extends vscode.TreeItem {
  constructor(
    public readonly node: ExplorerNode,
    collapsibleState: vscode.TreeItemCollapsibleState,
  ) {
    super(node.label, collapsibleState);

    this.description = node.description;

    if (node.type === "connection") {
      this.contextValue = "postgresConnection";
      this.iconPath = new vscode.ThemeIcon("plug");
      this.command = {
        command: "postgresPlugin.connectSaved",
        title: "Connect Saved Connection",
        arguments: [this.node],
      };
    } else if (node.type === "savedQueriesFolder") {
      this.contextValue = "postgresSavedQueriesFolder";
      this.iconPath = new vscode.ThemeIcon("folder-library");
    } else if (node.type === "savedQuery") {
      this.contextValue = "postgresSavedQuery";
      this.iconPath = new vscode.ThemeIcon("symbol-string");
      this.command = {
        command: "postgresPlugin.openQueryPanel",
        title: "Open Saved Query",
        arguments: [this.node],
      };
    } else if (node.type === "schema") {
      this.contextValue = "postgresSchema";
      this.iconPath = new vscode.ThemeIcon("database");
    } else if (node.type === "table") {
      this.contextValue = "postgresTable";
      this.iconPath = new vscode.ThemeIcon("table");
      this.command = {
        command: "postgresPlugin.previewTable",
        title: "Preview Table",
        arguments: [this.node],
      };
    } else if (node.type === "column") {
      this.contextValue = "postgresColumn";
      this.iconPath = new vscode.ThemeIcon("symbol-field");
    } else {
      this.contextValue = "postgresInfo";
      this.iconPath = new vscode.ThemeIcon("info");
    }
  }
}

export class PostgresTreeDataProvider implements vscode.TreeDataProvider<ExplorerItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    ExplorerItem | undefined | null | void
  >();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(
    private readonly service: PostgresService,
    private readonly getConnections: () => SavedConnection[],
    private readonly getActiveConnectionId: () => string | undefined,
    private readonly getSavedQueries: (
      connectionId: string,
    ) => SavedQueryTreeItem[],
  ) {}

  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  public getTreeItem(element: ExplorerItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: ExplorerItem): Promise<ExplorerItem[]> {
    if (!element) {
      const connections = this.getConnections();
      const activeConnectionId = this.getActiveConnectionId();

      if (connections.length === 0) {
        return [
          new ExplorerItem(
            {
              type: "info",
              label: "Brak zapisanych połączeń",
              description: "Kliknij Create Connection",
            },
            vscode.TreeItemCollapsibleState.None,
          ),
        ];
      }

      return connections.map((connection) => {
        const isActive = connection.id === activeConnectionId;
        return new ExplorerItem(
          {
            type: "connection",
            label: connection.name,
            connectionId: connection.id,
            description: `${connection.user}@${connection.host}:${connection.port}/${connection.database}${isActive ? " [active]" : ""}`,
          },
          vscode.TreeItemCollapsibleState.Collapsed,
        );
      });
    }

    if (element.node.type === "connection") {
      const activeConnectionId = this.getActiveConnectionId();
      const currentConnectionId = element.node.connectionId;
      if (!currentConnectionId) {
        return [];
      }

      const savedQueries = this.getSavedQueries(currentConnectionId);
      const children: ExplorerItem[] = [
        new ExplorerItem(
          {
            type: "savedQueriesFolder",
            label: "Saved Queries",
            connectionId: currentConnectionId,
            description: `${savedQueries.length}`,
          },
          vscode.TreeItemCollapsibleState.Collapsed,
        ),
      ];

      if (
        !this.service.isConnected() ||
        currentConnectionId !== activeConnectionId
      ) {
        children.push(
          new ExplorerItem(
            {
              type: "info",
              label: "Brak aktywnego połączenia",
              description: "Kliknij nazwę połączenia, aby się połączyć",
            },
            vscode.TreeItemCollapsibleState.None,
          ),
        );

        return children;
      }

      const schemas = await this.service.listSchemas();
      const schemaItems = schemas.map(
        (schema: DbSchema) =>
          new ExplorerItem(
            {
              type: "schema",
              label: schema.schema,
              connectionId: currentConnectionId,
              schema: schema.schema,
            },
            vscode.TreeItemCollapsibleState.Collapsed,
          ),
      );

      return [...children, ...schemaItems];
    }

    if (element.node.type === "savedQueriesFolder") {
      const connectionId = element.node.connectionId;
      if (!connectionId) {
        return [];
      }

      const savedQueries = this.getSavedQueries(connectionId);
      if (savedQueries.length === 0) {
        return [
          new ExplorerItem(
            {
              type: "info",
              label: "Brak zapisanych zapytań",
              description: "Zapisz zapytanie z panelu SQL",
            },
            vscode.TreeItemCollapsibleState.None,
          ),
        ];
      }

      return savedQueries.map(
        (query) =>
          new ExplorerItem(
            {
              type: "savedQuery",
              label: query.name,
              connectionId,
              queryId: query.id,
              description: query.updatedAt ? "saved" : undefined,
            },
            vscode.TreeItemCollapsibleState.None,
          ),
      );
    }

    if (element.node.type === "savedQuery") {
      return [];
    }

    if (!this.service.isConnected()) {
      return [
        new ExplorerItem(
          {
            type: "info",
            label: "Brak połączenia",
            description: "Wybierz aktywne połączenie z listy",
          },
          vscode.TreeItemCollapsibleState.None,
        ),
      ];
    }

    if (element.node.type === "schema") {
      const schemaName = element.node.schema!;
      const tables = await this.service.listTables(schemaName);

      return tables.map(
        (table: DbTable) =>
          new ExplorerItem(
            {
              type: "table",
              label: table.name,
              connectionId: element.node.connectionId,
              schema: schemaName,
              table: table.name,
              description: table.type,
            },
            vscode.TreeItemCollapsibleState.Collapsed,
          ),
      );
    }

    if (element.node.type === "table") {
      const schemaName = element.node.schema!;
      const tableName = element.node.table!;
      const columns = await this.service.listColumns(schemaName, tableName);

      return columns.map(
        (column: DbColumn) =>
          new ExplorerItem(
            {
              type: "column",
              label: column.name,
              connectionId: element.node.connectionId,
              schema: schemaName,
              table: tableName,
              description: `${column.dataType}${column.isNullable ? "" : " NOT NULL"}`,
            },
            vscode.TreeItemCollapsibleState.None,
          ),
      );
    }

    return [];
  }
}
