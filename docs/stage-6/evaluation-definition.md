# Evaluation definition

Definitions are JSON-only and every object is strict. Required fields are `version`, `id`, `task`, `tieTolerance`, `correctnessChecks`, `requirements`, `rules`, `changePolicy`, `dependencyPolicy`, `telemetryPolicy`, and `hiddenAssets`. Version and tolerance are exactly 1. IDs are globally unique; weights are positive finite numbers.

Supported checks are `command`, `file-exists`, `file-absent`, `text-present`, `text-absent`, `path-unchanged`, `path-changed`, `dependency-present`, `dependency-absent`, and `json-value`. Commands default to timeout 1800 and exit code `[0]`, and are declarations only in S6-01.

Paths are relative POSIX paths: no absolute paths, drive prefixes, backslashes, null bytes, or `..` segments. Package names are unscoped or scoped npm names, not URLs, paths, or versions. Policy arrays are unique and exact conflicts are rejected. Telemetry booleans are required. Hidden assets are relative to the definition and are not read or hashed by S6-01.

## Complete valid example

```json
{
  "version": 1,
  "id": "hero-rate-limit-v1",
  "task": "Add deterministic rate limiting to the public search API.",
  "tieTolerance": { "absoluteScorePoints": 1 },
  "correctnessChecks": [
    { "id": "build", "type": "command", "command": "npm run build", "timeoutSeconds": 1800, "successExitCodes": [0], "mandatory": true, "weight": 15 },
    { "id": "hidden-rate-limit-tests", "type": "command", "command": "npm run test:evaluation -- rate-limit", "timeoutSeconds": 1800, "successExitCodes": [0], "structuredReport": { "format": "vitest-json", "path": "artifacts/rate-limit-results.json" }, "mandatory": true, "weight": 25 }
  ],
  "requirements": [
    { "id": "REQ-429", "description": "Requests above the configured limit return HTTP 429.", "weight": 3, "mandatory": true, "checks": [{ "id": "REQ-429-check", "type": "text-present", "path": "src/middleware.ts", "text": "429" }] },
    { "id": "REQ-MIDDLEWARE", "description": "The existing middleware architecture is used.", "weight": 2, "mandatory": true, "checks": [{ "id": "REQ-MIDDLEWARE-check", "type": "file-exists", "path": "src/middleware.ts" }] }
  ],
  "rules": [
    { "id": "RULE-AUTH-UNCHANGED", "description": "Authentication files must remain unchanged.", "weight": 2, "severity": "material", "checks": [{ "id": "RULE-AUTH-UNCHANGED-check", "type": "path-unchanged", "path": "src/auth/**" }] },
    { "id": "RULE-NO-RATE-LIMIT-PACKAGE", "description": "No new rate-limiting package may be added.", "weight": 1, "severity": "normal", "checks": [{ "id": "RULE-NO-RATE-LIMIT-PACKAGE-check", "type": "dependency-absent", "package": "express-rate-limit" }] }
  ],
  "changePolicy": {
    "allowedPaths": ["src/middleware.ts", "src/rate-limit/**", "tests/**"],
    "protectedPaths": ["src/auth/**", "src/billing/**"],
    "ignoredPaths": ["dist/**", "coverage/**", ".camarade/**"],
    "requiredChangedPaths": ["src/middleware.ts"]
  },
  "dependencyPolicy": { "packageManager": "npm", "allowedAddedPackages": [], "forbiddenPackages": ["express-rate-limit"], "allowUnlistedAdditions": false },
  "telemetryPolicy": { "requireTokens": true, "requireRuntime": true },
  "hiddenAssets": ["hidden/rate-limit.test.ts"]
}
```

This example demonstrates schema structure only. Its commands, paths, requirements, and rules are illustrative and are not benchmark results.

S6-01 validates the definition but does not execute commands, read hidden assets, hash hidden assets, calculate scores, or declare an outcome.

Invalid relative paths, symlink files, unknown properties, tolerance `1.1`, duplicate IDs, and conflicting policy patterns are rejected with typed errors. The loader requires an absolute regular non-symlink file, checks size before reading, enforces 1 MiB, uses JSON.parse, and validates structure and semantics. S6-02 will protect hidden assets.
