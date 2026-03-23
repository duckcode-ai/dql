# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| 0.5.x | Yes — active development |
| 0.4.x and earlier | No — please upgrade |

---

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report security issues privately by emailing **security@duckcode.ai**. Include:

1. A description of the vulnerability and its potential impact
2. Steps to reproduce (minimal example preferred)
3. Your contact information for follow-up

We will acknowledge receipt within 2 business days and aim to issue a fix or mitigation within 14 days for confirmed vulnerabilities.

---

## Scope

This security policy applies to the open-source DQL repository:

- `@duckcodeailabs/dql-cli` and all CLI commands
- `@duckcodeailabs/dql-core`, `dql-compiler`, `dql-connectors`, `dql-governance`, `dql-notebook`, `dql-runtime`, `dql-lsp`, `dql-project`
- The `DQL Language Support` VS Code extension

Issues in third-party dependencies should be reported upstream to those projects.

---

## Security Considerations for Self-Hosted Use

DQL runs a local HTTP server when you run `dql notebook`. By default:

- The server binds to `127.0.0.1` (localhost only)
- No authentication is applied to the API endpoints
- SQL queries entered in the notebook are executed directly against your configured database connection

**Do not expose the DQL notebook server to untrusted networks.** The server is designed for local development use only.

---

## Credential Handling

DQL reads database credentials from `dql.config.json`. Best practices:

- Do not commit `dql.config.json` if it contains passwords or access tokens
- Use environment variable references where supported: `"password": "${DB_PASSWORD}"`
- Add `dql.config.json` to your `.gitignore` if it contains secrets
