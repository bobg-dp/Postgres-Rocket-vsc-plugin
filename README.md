# DeePee - PostgreSQL VS Code Extension

DeePee is a VS Code extension for working with PostgreSQL using a UI-first workflow.

## Open Source and Support

This extension is free and open source.
If it helps you and you would like to buy me a coffee, you can do it here:
https://buycoffee.to/driftingpixel

## Features

- Dedicated PostgreSQL panel in the Activity Bar
- Saved connection list with quick connect
- Connection form in an editor tab (Webview)
- Password visibility toggle (`Show` / `Hide`)
- Connection test before save (`Test Connection`)
- Edit and delete connections from the context menu
- Schema -> table -> column explorer
- SQL query panel opened from icon next to connection name
- SQL autocomplete in query editor (table and column suggestions)
- Query execution with `Proceed` and tabular results below the editor
- Saved SQL queries per connection in tree (`Saved Queries` folder)
- Rename/delete saved queries from tree item actions
- Editable query results (popup cell editor + transactional save)
- Editable table view for table rows
- JSON-aware cell rendering and JSON validation in popup editor
- Transactional row updates (`COMMIT` on success, `ROLLBACK` on error)

## UI Workflow

1. Open the PostgreSQL icon in the Activity Bar.
2. In `Connections`, click `Create Connection`.
3. Fill in the connection form inside the opened tab.
4. Click `Test Connection`.
5. Click `Save Connection`.
6. Click a saved connection to connect.

## Managing Connections

1. Right-click a saved connection in the `Connections` view.
2. Choose `Edit Connection` or `Delete Connection`.

## Working With Tables

1. Expand a connected schema and open a table.
2. Rows are shown in an editable table.
3. Resize columns by dragging the right edge of a column header.
4. Click a cell value to open the popup editor.

## SQL Query Panel

1. In `Connections`, click the query icon next to a saved connection.
2. Type SQL in the editor.
3. Use autocomplete while typing.
4. Suggestions for tables and columns appear while typing.
5. Press `Ctrl+Space` (or `Cmd+Space`, depending on system shortcut settings) to force suggestions.
6. Click `Proceed` to execute.
7. Results are rendered directly under the query panel.
8. Click `Save` to store or update a query for the current connection.

## Saved Queries In Tree

1. Expand a connection.
2. Open `Saved Queries` (first folder in that connection).
3. Click a saved query to open it in the SQL panel.
4. Use inline actions to rename or delete the saved query.
5. Saving from the SQL panel updates the currently opened saved query.

## Editing Query Results

1. Run a simple single-table `SELECT` query in SQL panel.
2. Click a result cell to open popup editor.
3. Modify values (JSON is validated).
4. Click `Save Result Changes`.
5. Changes are saved in one transaction.
6. On success extension performs `COMMIT`.
7. On error extension performs `ROLLBACK`.

## Limitations

1. Query-result editing is enabled only for simple single-table `SELECT` queries.
2. Complex queries are treated as read-only results, for example:
3. Queries with `JOIN`.
4. Queries with `UNION`, `INTERSECT`, or `EXCEPT`.
5. Queries with `GROUP BY` or `DISTINCT`.
6. To support transactional updates for query results, extension injects an internal `ctid` field into editable query execution.
7. If a system shortcut blocks `Ctrl+Space` or `Cmd+Space`, autocomplete still works while typing, but manual trigger may require changing OS/editor shortcut settings.

## Popup Cell Editor

- Text/number/boolean values: edited in a simple input popup
- JSON/JSONB values: edited in a larger JSON popup with validation
- Invalid JSON is blocked before save

## Saving Changes (All or Nothing)

1. Modify one or more cells.
2. Changed fields are highlighted in light green.
3. Click `Save Changes` at the top.
4. The extension saves all row updates in a single transaction:
   - success -> `COMMIT`
   - error -> `ROLLBACK`
