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
- Query execution with `Proceed` and tabular results below the editor
- Saved SQL queries per connection with quick load/delete
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
3. Click `Proceed` to execute.
4. Results are rendered directly under the query panel.
5. Click `Save` to store the query for the current connection.

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
