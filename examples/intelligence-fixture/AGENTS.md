# Intelligence fixture instructions

- Reuse the shared API middleware for request protection.
- Do not add a dependency for rate limiting.
- Do not modify `src/auth.ts`.
- Use a fixed-window policy for rate limiting in the public search API.
- Use a sliding-window policy for rate limiting in the public search API.
