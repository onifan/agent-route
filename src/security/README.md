# Security Helpers

`src/security` contains deterministic safety helpers shared by API and tool layers.

- `cors.js` centralizes allowed-origin checks. Production origins must be listed in `AGENT_ROUTE_ALLOWED_ORIGINS`; local development allows `localhost` and `127.0.0.1`.
- `tool-risk-gate.js` blocks high/critical tool actions unless explicit approval is present.

This layer does not update task state, write memory, or decide recovery strategy. It returns structured results for callers to handle.
