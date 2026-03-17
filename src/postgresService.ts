import { Pool, PoolClient, QueryResult } from "pg";

export interface ConnectionConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
}

export interface DbSchema {
  schema: string;
}

export interface DbTable {
  schema: string;
  name: string;
  type: string;
}

export interface DbColumn {
  schema: string;
  table: string;
  name: string;
  dataType: string;
  isNullable: boolean;
}

export interface EditableTableData {
  columns: string[];
  columnTypes: Record<string, string>;
  totalRows: number;
  matchedRows: number;
  limit: number;
  rows: Array<{
    ctid: string;
    data: Record<string, unknown>;
  }>;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export class PostgresService {
  private pool: Pool | undefined;
  private transactionClient: PoolClient | undefined;
  private connectionLabel = "";

  public isConnected(): boolean {
    return this.pool !== undefined;
  }

  public isTransactionActive(): boolean {
    return this.transactionClient !== undefined;
  }

  public getConnectionLabel(): string {
    return this.connectionLabel;
  }

  public async connect(config: ConnectionConfig): Promise<void> {
    await this.disconnect();

    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : false,
      max: 10,
    });

    await this.pool.query("SELECT 1");
    this.connectionLabel = `${config.user}@${config.host}:${config.port}/${config.database}`;
  }

  public async disconnect(): Promise<void> {
    if (this.transactionClient) {
      await this.safeRollback(this.transactionClient);
      this.transactionClient.release();
      this.transactionClient = undefined;
    }

    if (this.pool) {
      await this.pool.end();
      this.pool = undefined;
    }

    this.connectionLabel = "";
  }

  public async beginTransaction(): Promise<void> {
    this.ensureConnected();

    if (this.transactionClient) {
      throw new Error("Transakcja jest już aktywna.");
    }

    this.transactionClient = await this.pool!.connect();
    await this.transactionClient.query("BEGIN");
  }

  public async commitTransaction(): Promise<void> {
    if (!this.transactionClient) {
      throw new Error("Brak aktywnej transakcji.");
    }

    try {
      await this.transactionClient.query("COMMIT");
    } finally {
      this.transactionClient.release();
      this.transactionClient = undefined;
    }
  }

  public async rollbackTransaction(): Promise<void> {
    if (!this.transactionClient) {
      throw new Error("Brak aktywnej transakcji.");
    }

    try {
      await this.transactionClient.query("ROLLBACK");
    } finally {
      this.transactionClient.release();
      this.transactionClient = undefined;
    }
  }

  public async execute(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult> {
    this.ensureConnected();

    if (this.transactionClient) {
      return this.transactionClient.query(sql, params);
    }

    return this.pool!.query(sql, params);
  }

  public async listSchemas(): Promise<DbSchema[]> {
    const result = await this.execute(
      `
      SELECT schema_name AS schema
      FROM information_schema.schemata
      WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
      ORDER BY schema_name
      `,
    );

    return result.rows.map((row) => ({ schema: String(row.schema) }));
  }

  public async listTables(schema: string): Promise<DbTable[]> {
    const result = await this.execute(
      `
      SELECT table_schema AS schema,
             table_name AS name,
             table_type AS type
      FROM information_schema.tables
      WHERE table_schema = $1
      ORDER BY table_name
      `,
      [schema],
    );

    return result.rows.map((row) => ({
      schema: String(row.schema),
      name: String(row.name),
      type: String(row.type),
    }));
  }

  public async listColumns(schema: string, table: string): Promise<DbColumn[]> {
    const result = await this.execute(
      `
      SELECT table_schema AS schema,
             table_name AS table,
             column_name AS name,
             data_type AS data_type,
             is_nullable AS is_nullable
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
      `,
      [schema, table],
    );

    return result.rows.map((row) => ({
      schema: String(row.schema),
      table: String(row.table),
      name: String(row.name),
      dataType: String(row.data_type),
      isNullable: String(row.is_nullable).toUpperCase() === "YES",
    }));
  }

  public async previewRows(
    schema: string,
    table: string,
    limit = 100,
  ): Promise<Record<string, unknown>[]> {
    const safeSchema = quoteIdentifier(schema);
    const safeTable = quoteIdentifier(table);

    const result = await this.execute(
      `SELECT * FROM ${safeSchema}.${safeTable} LIMIT $1`,
      [limit],
    );

    return result.rows;
  }

  public async previewRowsForEditor(
    schema: string,
    table: string,
    limit = 100,
    search = "",
  ): Promise<EditableTableData> {
    const safeSchema = quoteIdentifier(schema);
    const safeTable = quoteIdentifier(table);
    const columnMetadata = await this.listColumns(schema, table);
    const columns = columnMetadata.map((column) => column.name);
    const columnTypes: Record<string, string> = {};
    for (const column of columnMetadata) {
      columnTypes[column.name] = column.dataType.toLowerCase();
    }

    const normalizedLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    const normalizedSearch = search.trim();
    const hasSearch = normalizedSearch.length > 0;

    const concatenatedColumns =
      columns.length > 0
        ? columns
            .map(
              (column) =>
                `COALESCE(${quoteIdentifier(column)}::text, '')`,
            )
            .join(", ")
        : "''";
    const whereClause = hasSearch
      ? `WHERE CONCAT_WS(' ', ${concatenatedColumns}) ILIKE $1`
      : "";
    const queryParams = hasSearch ? [`%${normalizedSearch}%`, normalizedLimit] : [normalizedLimit];

    const totalResult = await this.execute(
      `SELECT COUNT(*)::bigint AS total FROM ${safeSchema}.${safeTable}`,
    );
    const totalRows = Number(totalResult.rows[0]?.total ?? 0);

    let matchedRows = totalRows;
    if (hasSearch) {
      const matchedResult = await this.execute(
        `SELECT COUNT(*)::bigint AS total FROM ${safeSchema}.${safeTable} ${whereClause}`,
        [`%${normalizedSearch}%`],
      );
      matchedRows = Number(matchedResult.rows[0]?.total ?? 0);
    }

    const result = await this.execute(
      `SELECT ctid::text AS __ctid__, * FROM ${safeSchema}.${safeTable} ${whereClause} ORDER BY ctid LIMIT $${queryParams.length}`,
      queryParams,
    );

    const rows = result.rows.map((row) => {
      const ctid = String(row.__ctid__);
      const data: Record<string, unknown> = {};

      for (const column of columns) {
        data[column] = row[column];
      }

      return { ctid, data };
    });

    return {
      columns,
      columnTypes,
      totalRows,
      matchedRows,
      limit: normalizedLimit,
      rows,
    };
  }

  public async updateRowByCtid(
    schema: string,
    table: string,
    ctid: string,
    changes: Record<string, unknown>,
  ): Promise<void> {
    const entries = Object.entries(changes);
    if (entries.length === 0) {
      return;
    }

    const safeSchema = quoteIdentifier(schema);
    const safeTable = quoteIdentifier(table);
    const setClause = entries
      .map(([column], index) => `${quoteIdentifier(column)} = $${index + 1}`)
      .join(", ");
    const values = entries.map(([, value]) => value);
    values.push(ctid);

    await this.execute(
      `UPDATE ${safeSchema}.${safeTable} SET ${setClause} WHERE ctid::text = $${values.length}`,
      values,
    );
  }

  private ensureConnected(): void {
    if (!this.pool) {
      throw new Error("Brak połączenia z bazą danych.");
    }
  }

  private async safeRollback(client: PoolClient): Promise<void> {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback failures during disconnect.
    }
  }
}
