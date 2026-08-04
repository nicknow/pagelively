# 0042: S23-A implementation details — password/token primitives, unlock & asset routes, benchmark stop-and-report

- Status: accepted
- Date: 2026-08-02

## Context

S23-A implements the pure primitives of the per-page password feature: password
validation/hashing/verification (`src/password.ts`), unlock token & cookie
helpers (`src/password-token.ts`), the inline prompt page
(`src/password-prompt.ts`), the `protected` cache class (`src/cache-headers.ts`),
and the two new public route families (`src/router.ts`). The feature-level
decisions (credential model, PBKDF2 scheme, prompt disclosure, routing,
`protected` cache class) are locked in ADR 0041; this record captures the
slice-level shapes and the S23-A benchmark outcome required by ADR 0041's
Consequences ("S23-A must measure and record the actual figure").

## Decision

1. **`validatePassword(pw: unknown)` returns a typed discriminated union** with
   `status` as the discriminator:
   `{ status: "not-set" } | { status: "valid"; value: string } | { status:
"invalid"; code: "not-a-string" | "too-short" | "too-long"; message: string }`.
   `not-set` covers empty / whitespace-only / `null` / `undefined` (the "no
   password" state, valid for clearing — ADR 0041 decision 2). `valid` carries
   the **trimmed** value (validation and hashing operate on the trimmed string,
   so the value the caller hashes is the value that was validated). Rules: min
   5 chars after trim, max 256 chars after trim (bounds the PBKDF2 input).
   Invalid results always carry an actionable message; the function is total.

2. **`verifyPassword` is strict about the stored format** (ADR 0041 decision 2:
   malformed → `false`, never throws): exactly 4 `$`-segments, scheme
   `pbkdf2`, iteration count **plain decimal digits** (`/^\d+$/` — rejects
   `1e5`), a safe integer in `1..1_000_000` (absurdity cap), salt decodes to
   non-empty bytes, and the expected key is **exactly 32 bytes** (256 bits —
   the fixed output of our `hashPassword`; anything else is malformed). The
   derivation uses the stored salt and iteration count, and the comparison is
   `constantTimeEqual` (xor-accumulate, no early exit on length).

3. **`parseUnlockCookie` is strict and total** (malformed == absent, ADR 0041
   decision 1): exactly one `.`, the page id validated with the shared
   `validateId` charset (`/^[A-Za-z0-9_-]{1,64}$/`), and the token must be a
   base64url string that decodes to **exactly 32 bytes** (43 unpadded chars) —
   anything else returns `null`, never throws. An uppercase variant of a valid
   token still parses (structure is not content; the D1 hash lookup decides).

4. **Base64url helpers live in `src/password.ts`** (`base64UrlEncode` /
   `base64UrlDecode`, unpadded, RFC 4648 §5) and are imported by
   `src/password-token.ts`; `atob`/`btoa` are Workers-native and used
   directly (no dependency added). Encoding raw bytes is treated as a crypto
   primitive alongside PBKDF2.

5. **`classifyPath` additions (ADR 0041 decision 6), concretized:**
   - `unlock`: `/p/{id}/unlock[/]` — the literal matches **case-insensitively**
     (consistent with `health`/reserved matching); exactly that depth; the id
     segment stays raw. `/p/{id}/unlock/x` and deeper → `unknown`.
   - `asset`: `/assets/pages/{id}/{rev}/{path…}` — the `assets` prefix matches
     case-insensitively (reserved, ADR 0007); the `pages` literal also matches
     **case-insensitively** for consistency with every other literal in the
     router; **at least one path segment is required** (the R2 object layout
     is `pages/{id}/{rev}/{path}` with a non-empty path — `/assets/pages/{id}/
{rev}` without a path is `unknown` → clean 404); id/rev are kept raw
     (structural validation is the handler's job, S23-C); `path` = remaining
     raw segments joined with `/`.
   - `%2F` anywhere, empty segments, and any other `/assets/…` shape remain
     `unknown` (unchanged rules).

6. **`src/index.ts` is untouched by S23-A.** The `Route` union change does not
   break typecheck (dispatch is if-chains with a clean-404 fallthrough, not an
   exhaustive switch); new `unlock`/`asset` routes currently fall through to
   the existing clean 404 — S23-C wires the full dispatch.

7. **PBKDF2 benchmark (required by ADR 0041 Consequences) — resolved by the human:
   10,000 iterations.** Measured inside the workerd pool (the Workers runtime):
   `hashPassword` at 100,000 iterations ≈ **38–40 ms median** (mean ≈ 40–43 ms) on the local
   dev hardware; per-iteration cost ≈ 0.4 µs (linear at 100k/25k/10k). This is **~10× the
   ~4 ms threshold** (40% of the Free-plan 10 ms CPU/request budget), so S23-A
   **stop-and-reported**: no silent tuning, no ADR amendment from the slice. The human
   then **decided to adopt 10,000 iterations (~4 ms ≈ 40% of the budget)** as the default;
   that change is recorded as an amendment to **ADR 0041 decision 2** (with the measured
   figures in ADR 0041 Consequences) and implemented here — `PBKDF2_ITERATIONS = 10_000` in
   `src/password.ts`. The storage format is self-describing, so hashes stored at the old
   100k default still verify (forward-compat tested in `test/password.test.ts`); the
   `verifyPassword` cap of 1,000,000 is unchanged. Any further count change remains an ADR
   0041 amendment, never a silent tweak. Note: OWASP's ~600k PBKDF2-HMAC-SHA256 guidance
   cannot fit the 10 ms budget on this hardware (~240 ms measured); deployed Cloudflare CPUs
   may be faster, but that cannot be measured locally (no account; `cfapi` denied).

## Consequences

- S23-C/D call `validatePassword` first and only hash/verify on the
  `valid`/`not-set` branches — the union makes the call-site semantics
  (set vs clear vs unchanged) explicit and type-checked.
- Strict cookie parsing means only well-formed 32-byte-token cookies ever reach
  a D1 lookup; everything else is an absent cookie.
- The benchmark finding is a genuine security-vs-CPU compromise, **resolved**: one PBKDF2
  derivation per unlock attempt at the adopted 10,000 iterations stays within ~40% of the
  request budget (~4 ms measured on the benchmark machine); the page-view path is unaffected
  (one D1 PK read + one SHA-256 + one constant-time compare, ADR 0041 decision 1).

## Cross-references

- ADR 0041 (S23 feature decisions, decisions 1, 2, 5, 6, 9 and the CPU-budget
  consequence), ADR 0007 (reserved words), ADR 0010 (route classification
  details).
- Docs: `docs/architecture/02-module-boundaries-contracts.md` (Route union,
  `CacheRouteClass.protected`, module contracts).
- Scratch: `.work/implementer/s23-a-benchmark.md` (benchmark method + numbers).
