export class EvaluateTaskError extends Error { constructor(readonly code: string, message: string) { super(message); this.name = "EvaluateTaskError" } }
