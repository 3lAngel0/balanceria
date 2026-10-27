# Security and Privacy

`ai-balancer` is designed with an offline-first, local-first architecture. It operates entirely on your local machine, within your coding-agent harness (Gentle Shell / Pi), without third-party telemetry servers or cloud tracking.

---

## Data Handled by ai-balancer

### 1. Local Filesystem Only
All runtime data, telemetry, and decision traces are written directly to your local `data/` directory (or the path defined by `AI_BALANCER_DATA_DIR`):

| File / Directory | Purpose | Access & Permissions |
|---|---|---|
| `data/events.jsonl` | Append-only shared stream of routing events, token totals, quota snapshots, and exhaustion events. | Local process only |
| `data/history/YYYY-MM-DD.jsonl` | Daily request ledger recording tokens (`input`, `output`, `cacheRead`, `cacheWrite`), context sizes, session IDs, project folder names, provider, and model. Rotated after 30 days. | Local process only |
| `data/settings.json` | Local user preferences, such as language configuration (`en` or `es`). | Local process only |
| `data/loans.json` | State journal tracking temporary model loans during quota exhaustion. | Local process only |
| `data/permissions.json` | Security grant ledger for autonomous or suggested model loan approvals. | Local process only |
| `data/agy-report.json` | Atomic cache of provider quota limit windows from Antigravity (`agy`). | Local process only |
| `data/claude-usage.json` | Atomic cache of rate-limit window usage from Claude Bridge. | Local process only |
| `data/circuit-breaker-checkpoint.json` | Emergency session checkpoint saved when all candidates in a pool are exhausted. | Local process only |
| `data/web-token` | High-entropy random authentication token generated on first run. | Strict file permission `0600` (user read/write only) |
| `data/web-serve.json` | State file tracking web dashboard port, PID, LAN mode, and TLS configuration. | Local process only |

### 2. Files Read from Gentle Shell
To coordinate with Gentle Shell and Pi, `ai-balancer` reads:
- `~/.gentle-shell/config/gentle-ai/profiles.json`: The profile mapping agent roles to models or virtual pools. Writes to this file occur only upon explicit user confirmation (e.g., during `/balancer setup` or lab draft application) and include timestamped backups (`.bak-YYYYMMDDHHMMSS`).
- `~/.gentle-shell/agent/gentle-agents/tasks/`: Completed task metadata used to associate subagent sessions with their caller role in historical reports.
- `process.argv`: The active process command-line arguments to extract `--append-system-prompt` flags for real-time role resolution.

---

## Credentials and API Keys

- **No API keys are stored in this repository.**
- Direct API keys (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`) are read strictly from your environment variables at runtime. They are never written to `data/` or any log file.
- Bridge integrations (`agy`, `claude`, `opencode`, `ollama`) communicate through their respective local CLIs or local IPC bridges. `ai-balancer` only reads quota percentages and token usage counters from them.

---

## Web Dashboard & Network Boundaries

The built-in web server (`/balancer serve`) provides interactive dashboards:

1. **Localhost Default**:
   - By default, the server binds strictly to `127.0.0.1`. It does not listen on external network interfaces.
2. **Mandatory Authentication**:
   - Every HTTP request requires authentication using the secret token stored in `data/web-token`. Requests without a valid token receive `401 Unauthorized`.
   - The token is passed via `Authorization: Bearer <token>` or an `HttpOnly`, `SameSite=Strict` cookie.
3. **DNS Rebinding Protection**:
   - The server validates the HTTP `Host` header. Requests with unrecognized hostnames or public domain names are rejected immediately, even if a token is present.
4. **LAN Mode Isolation (`/balancer serve lan`)**:
   - When explicitly enabled, LAN access is restricted to private IP subnets defined by RFC 1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) and IPv6 Unique Local Addresses (ULA).
   - Public IP addresses attempting to reach the server receive `403 Forbidden`.
5. **TLS Encryption**:
   - The LAN wizard (`/balancer serve setup`) configures TLS HTTPS with either self-signed certificates, a local CA (via `mkcert`), or user-provided PEM certificates. Unencrypted sensitive actions over LAN are blocked.

---

## Pre-Publication Checklist

Before publishing changes or deploying `ai-balancer` to an open-source or shared environment:

- [ ] **No Absolute Paths**: Verify that documentation and source files do not contain personal home paths (e.g., `/home/username`). Use relative paths or generic placeholders like `<path-to-repo>`.
- [ ] **No Secrets or Credentials**: Ensure `.env`, API keys, session tokens, or private certificates are not tracked in git. Verify that `.gitignore` covers `data/`, `node_modules/`, and `*.pem`.
- [ ] **Data Directory Scoped**: Verify that `data/` contains only test fixtures or is omitted from version control.
- [ ] **File Permissions**: Verify that `data/web-token` is created with mode `0600`.
- [ ] **Clean Test Execution**: Run `npm test` to ensure all tests pass deterministically without network dependencies.
