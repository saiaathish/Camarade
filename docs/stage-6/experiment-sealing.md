# S6-02 experiment sealing

Stage 5 optionally accepts an absolute evaluation-definition path. Camarade validates the definition and matches its normalized task before creating worktrees or starting an agent. When omitted, Stage 5 records explicit unavailable evidence and Stage 6 remains limited.

Sealed definitions are copied into controller-owned storage under `evaluation/`. Hidden assets are resolved relative to the definition, must be regular non-symlink files outside the target repository, and are copied byte-for-byte without entering worktrees, prompts, or context artifacts.

Definition hashes use canonical validated JSON. Hidden-asset hashes use sorted relative paths, byte hashes, and lengths. The seal hash covers the complete seal payload without its own hash. Source files are reread before publication; mutation aborts preparation.

```json
{"status":"sealed","sealVersion":1,"definitionId":"hero-rate-limit-v1","definitionVersion":1,"definitionHash":"...","hiddenAssetsHash":"...","sealHash":"...","sealedAt":"2026-01-01T00:00:00.000Z","sealManifestRelativePath":"evaluation/evaluation-seal.json","definitionRelativePath":"evaluation/evaluation-definition.json"}
```

Unavailable references contain `status: "unavailable"` and reason `EVALUATION_DEFINITION_NOT_PROVIDED`. Integrity verification classifies trustworthy sealed evidence as `valid`, absent optional evidence or legacy artifacts as `limited`, and mismatched or tampered evidence as `invalid`.

Stage 6 re-verifies the sealed definition, hidden assets, timestamps, condition controls, patches, and artifact index before any declared command executes. A supplied measurement definition must hash to the pre-run sealed definition.
