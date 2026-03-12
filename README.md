# MCP Database Server

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for querying SQL databases with built-in security guardrails. Connects AI assistants to your databases safely with column masking, JSON-path masking, row filters, and query restrictions.

## Supported Databases

- **PostgreSQL** (and compatible: Aurora, Supabase, Neon, etc.)
- **MySQL** (and MariaDB)
- **ClickHouse**

## Features

- **Three MCP tools**: `db_list_tables`, `db_describe_table`, `db_query`
- **Column masking**: email, phone, SSN, credit card, name, IP, full redaction
- **JSON-path masking**: mask PII inside JSON/JSONB columns (nested paths, arrays)
- **Row filters**: Automatic WHERE clause injection per table
- **Query safety**: Only SELECT allowed; DDL/DML/multi-statement blocked
- **Dangerous function blocking**: `pg_read_file`, `dblink`, etc.
- **SSRF protection**: Private IPs, localhost, cloud metadata endpoints blocked
- **LIMIT enforcement**: Max 1000 rows per query (configurable)
- **Read-only transactions**: All queries wrapped in read-only transactions
- **Two transport modes**: stdio (embedded) and HTTP (on-premise relay)
- **API key authentication**: Timing-safe Bearer token auth for HTTP mode
- **TLS support**: HTTPS with custom certificates

## Quick Start

### Installation

```bash
npm install @nucleusenterprise/mcp-database-server
```

Or clone and build from source:

```bash
git clone https://github.com/nucleusenterpriseai/database-mcp-server.git
cd database-mcp-server
npm install
npm run build
```

### Mode 1: Stdio (Embedded)

Use as a subprocess spawned by an MCP client (e.g., Claude Desktop, Cursor, or any MCP-compatible tool).

Set environment variables and run:

```bash
export DB_CREDENTIALS='{"host":"db.example.com","port":5432,"username":"readonly","password":"secret","database":"myapp","db_type":"postgres","ssl_mode":"require"}'
export DB_CONFIG='{"db_type":"postgres","allowed_tables":["public.users","public.orders"],"masking_rules":[{"table":"users","column":"email","type":"email"}],"row_filters":[]}'

node dist/index.js
```

#### Claude Desktop Configuration

Add to your Claude Desktop MCP config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "database": {
      "command": "node",
      "args": ["/path/to/database-mcp-server/dist/index.js"],
      "env": {
        "DB_CREDENTIALS": "{\"host\":\"localhost\",\"port\":5432,\"username\":\"readonly\",\"password\":\"secret\",\"database\":\"myapp\",\"db_type\":\"postgres\",\"ssl_mode\":\"disable\"}",
        "DB_CONFIG": "{\"db_type\":\"postgres\",\"allowed_tables\":[\"public.users\"],\"masking_rules\":[],\"row_filters\":[]}"
      }
    }
  }
}
```

### Mode 2: HTTP (On-Premise Relay)

Run as a standalone HTTP server with API key authentication. Useful for shared deployments where multiple clients connect to the same server.

1. Generate an API key:

```bash
node dist/cli.js generate-key
```

2. Create a config file (`db-mcp-server.yaml`):

```yaml
server:
  port: 8443
  api_key: ${MCP_API_KEY}

database:
  type: postgres
  host: db.example.com
  port: 5432
  username: readonly
  password: ${DB_PASSWORD}
  database: myapp
  ssl_mode: require

security:
  allowed_tables:
    - public.users
    - public.orders
  masking_rules:
    - table: users
      column: email
      type: email
  json_path_masking_rules:
    - table: customers
      column: details
      paths:
        - path: ssn
          mask: ssn_last4
        - path: contact.phone
          mask: phone_last4
        - path: dependents[].name
          mask: name_initial
        - path: home_address
          mask: redact
  row_filters:
    - table: orders
      condition: "status = 'active'"
```

3. Start the server:

```bash
export MCP_API_KEY=your-generated-key
export DB_PASSWORD=your-db-password
node dist/cli.js start --config db-mcp-server.yaml
```

4. Connect an MCP client using the Streamable HTTP transport:

```
POST http://localhost:8443/mcp
Authorization: Bearer your-generated-key
Content-Type: application/json
```

### Docker

```bash
docker build -t mcp-database-server .
docker run -p 8443:8443 \
  -v $(pwd)/config.yaml:/app/config/db-mcp-server.yaml:ro \
  -e MCP_API_KEY=your-key \
  -e DB_HOST=db.example.com \
  -e DB_PASSWORD=secret \
  mcp-database-server
```

Or use Docker Compose (see `examples/docker-compose.yml`).

## CLI Reference

```
db-mcp-server v1.0.0

Usage:
  db-mcp-server start [--config <path>]   Start HTTP server (default: ./db-mcp-server.yaml)
  db-mcp-server generate-key              Generate a new API key
  db-mcp-server test-connection [--config] Test database connectivity
  db-mcp-server --version                 Print version
  db-mcp-server --help                    Print this help message
```

## MCP Tools

### `db_list_tables`

List all tables and views the user has access to.

**Parameters:**
- `schema` (optional): Filter by schema name

**Returns:** Array of `{ schema, name, type, approximate_row_count }`

### `db_describe_table`

Get detailed schema for a specific table: columns, types, constraints, and sample rows.

**Parameters:**
- `table` (required): Table name (e.g., `public.orders` or `orders`)
- `sample_rows` (optional): Number of sample rows (default: 3, max: 10)

**Returns:** `{ schema, table, columns, constraints, sample_rows }`

### `db_query`

Execute a read-only SQL query. All queries pass through the security pipeline.

**Parameters:**
- `sql` (required): SQL SELECT query

**Returns:** `{ columns, rows, row_count }`

## JSON-Path Masking

Mask PII fields inside JSON/JSONB columns without losing the surrounding data. JSON-path masking runs post-query in memory — it works with any database (PostgreSQL JSONB, MySQL JSON, ClickHouse String containing JSON, key-value tables, etc.).

### Path Syntax

| Pattern | Matches | Example |
|---------|---------|---------|
| `key` | Top-level field | `email` → `obj.email` |
| `a.b.c` | Nested field | `contact.phone` → `obj.contact.phone` |
| `items[].name` | Field in each array element | `dependents[].name` → `obj.dependents[0].name`, `obj.dependents[1].name`, ... |
| `a[].b[].c` | Nested arrays | `groups[].members[].ssn` → every `ssn` in every `member` in every `group` |

### Supported Mask Types

| Type | Input | Output |
|------|-------|--------|
| `email` | `alice@example.com` | `a***@example.com` |
| `phone_last4` | `+65-9123-4567` | `***-***-4567` |
| `ssn_last4` | `S1234567A` | `***-**-567A` |
| `name_initial` | `Alice Johnson` | `A***` |
| `credit_card` | `4111-1111-1111-1234` | `****-****-****-1234` |
| `ip_partial` | `192.168.1.100` | `192.xxx.xxx.xxx` |
| `redact` | `any value` | `[REDACTED]` |
| `none` | `any value` | (unchanged) |

### Configuration Examples

**Simple — mask fields in a JSON column:**

```yaml
security:
  json_path_masking_rules:
    - table: customers
      column: profile_data
      paths:
        - path: full_name
          mask: name_initial
        - path: phone
          mask: phone_last4
        - path: national_id
          mask: ssn_last4
```

**Nested objects — mask `contact.email` inside a JSON column:**

```yaml
security:
  json_path_masking_rules:
    - table: employees
      column: metadata
      paths:
        - path: personal.email
          mask: email
        - path: personal.home_address
          mask: redact
        - path: emergency_contact.phone
          mask: phone_last4
```

**Arrays — mask each element's field:**

```yaml
security:
  json_path_masking_rules:
    - table: hr_records
      column: family_info
      paths:
        - path: dependents[].name
          mask: name_initial
        - path: dependents[].id_number
          mask: ssn_last4
```

**Key-value tables (e.g., `param_key`/`param_value` pattern):**

When a table stores JSON blobs in a generic value column with varying schemas per key, JSON-path masking handles it gracefully — paths that don't exist in a particular row's JSON are silently skipped.

```yaml
security:
  json_path_masking_rules:
    - table: settings
      column: param_value
      paths:
        - path: nric
          mask: ssn_last4
        - path: phone
          mask: phone_last4
        - path: full_name
          mask: name_initial
        - path: address
          mask: redact
        - path: members[].identity_number
          mask: ssn_last4
```

**Combine with column masking and row filters:**

```yaml
security:
  # Column-level SQL masking (rewrites queries)
  masking_rules:
    - table: customers
      column: email
      type: email

  # JSON-path masking (post-query, in-memory)
  json_path_masking_rules:
    - table: customers
      column: profile_json
      paths:
        - path: ssn
          mask: ssn_last4

  # Row filters (injected WHERE clauses)
  row_filters:
    - table: customers
      condition: "is_deleted = 0"
```

## Configuration Reference

### Environment Variables (Stdio Mode)

| Variable | Description |
|----------|-------------|
| `DB_CREDENTIALS` | JSON string with database connection credentials |
| `DB_CONFIG` | JSON string with security configuration |
| `MCP_TRANSPORT` | Transport mode: `stdio` (default) or `http` |

### DB_CREDENTIALS Schema

```json
{
  "host": "db.example.com",
  "port": 5432,
  "username": "readonly",
  "password": "secret",
  "database": "myapp",
  "db_type": "postgres",
  "ssl_mode": "require"
}
```

| Field | Required | Values |
|-------|----------|--------|
| `host` | Yes | Database hostname or IP |
| `port` | Yes | Port number |
| `username` | Yes | Database username |
| `password` | No | Database password |
| `database` | Yes | Database name |
| `db_type` | Yes | `postgres`, `mysql`, `clickhouse` |
| `ssl_mode` | No | `disable`, `require`, `verify-ca`, `verify-full` |

### DB_CONFIG Schema

```json
{
  "db_type": "postgres",
  "allowed_tables": ["public.users", "public.orders"],
  "masking_rules": [
    { "table": "users", "column": "email", "type": "email" }
  ],
  "json_path_masking_rules": [
    { "table": "users", "column": "profile_json", "paths": [
      { "path": "phone", "mask": "phone_last4" },
      { "path": "home_address", "mask": "redact" }
    ]}
  ],
  "row_filters": [
    { "table": "orders", "condition": "status = 'active'" }
  ]
}
```

### Masking Types

| Type | Example Output |
|------|---------------|
| `email` | `j***@example.com` |
| `phone_last4` | `***-***-1234` |
| `ssn_last4` | `***-**-5678` |
| `credit_card` | `****-****-****-4242` |
| `name_initial` | `J***` |
| `ip_partial` | `192.xxx.xxx.xxx` |
| `redact` | `[REDACTED]` |
| `none` | No masking applied |

### Config File (HTTP Mode)

YAML or JSON config files support `${ENV_VAR}` expansion. See `examples/config.yaml` for a full example.

### TLS/HTTPS Setup

Add TLS configuration to the config file:

```yaml
server:
  port: 8443
  api_key: ${MCP_API_KEY}
  tls:
    cert: /path/to/server.crt
    key: /path/to/server.key
```

## Security

### Query Safety Pipeline

Every query passes through a 5-stage pipeline:

1. **Classify** - Block DDL, DML, multi-statement, session manipulation, dangerous functions
2. **Validate tables** - Ensure only allowed tables are referenced
3. **Apply masking** - Rewrite SELECT columns with masking expressions
4. **Inject row filters** - Append WHERE clauses for row-level access control
5. **Enforce LIMIT** - Cap results at 1000 rows

### SSRF Protection

Database host validation blocks:
- Private networks: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
- Loopback: `127.0.0.0/8`, `::1`
- Link-local: `169.254.0.0/16` (includes AWS metadata `169.254.169.254`)
- IPv6 unique local: `fd00::/8`
- Hostname suffixes: `.internal`, `.local`

DNS resolution is performed for hostnames to catch private-IP aliases.

### Read-Only Enforcement

- PostgreSQL: `BEGIN READ ONLY` / `ROLLBACK`
- MySQL: `SET SESSION TRANSACTION READ ONLY` / `START TRANSACTION` / `ROLLBACK`
- ClickHouse: `readonly=1` setting

## Development

```bash
npm install
npm run build
npm test
npm run test:watch  # Watch mode
```

## License

Apache License 2.0 - see [LICENSE](LICENSE) for details.
