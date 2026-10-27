# Security and privacy

This is an experimental, single-user localhost application, not a hosted or multi-user service.

- Do not expose its HTTP port publicly or put it behind a public reverse proxy.
- Keep personal notes, `.discussions`, authentication files and logs out of commits and issues.
- Model requests are sent to the configured Codex service only after an explicit user action. Read the README for the included context and limits.
- Read-only execution settings are defense in depth, not a guarantee against every malicious input or dependency change.
- Back up your data, including hidden discussion files. Do not run multiple servers against the same notes directory.

Use GitHub's private vulnerability reporting feature when available. If unavailable, open a minimal issue requesting a private contact without publishing exploit details, credentials or personal data.
