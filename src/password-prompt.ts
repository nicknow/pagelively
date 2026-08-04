/**
 * S23-A — Inline password prompt page (ADR 0041 decisions 5 & 7, OQ-23).
 * Pure module — no bindings, no external resources.
 *
 * The document is fully inline (inline CSS only, no CDN/CSS/JS references)
 * and shows only the site name, the generic "This page is password
 * protected." text, and the unlock form. It never includes the page title or
 * any page content — a protected page's existence is not broadcast (parity
 * with the `unlisted` privacy posture). Every interpolated value is
 * HTML-escaped.
 */

import { escapeHtml } from "./utils";

export interface PasswordPromptOptions {
  siteName: string;
  /** Form action, e.g. `/p/{id}/unlock`. Escaped on output. */
  action: string;
  /** Optional inline error message. Escaped on output. */
  error?: string;
}

/**
 * Renders the complete password-prompt HTML document. The form posts to
 * `action`; the password input is `required minlength="5"` (the OQ-21 rule).
 * An `error` renders as an escaped inline paragraph; absent/empty renders no
 * error element.
 */
export function renderPasswordPrompt({ siteName, action, error }: PasswordPromptOptions): string {
  const name = escapeHtml(siteName);
  const actionAttr = escapeHtml(action);
  const errorBlock =
    error === undefined || error === ""
      ? ""
      : `\n    <p class="error" role="alert">${escapeHtml(error)}</p>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Password required — ${name}</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; line-height: 1.6; margin: 0; padding: 2rem 1rem; background: #f8fafc; color: #0f172a; -webkit-font-smoothing: antialiased; }
    main { max-width: 24rem; margin: 2rem auto; background: #ffffff; border-radius: 0.75rem; box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05), 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1); padding: 2rem; }
    h1 { margin: 0 0 0.5rem; font-size: 1.25rem; font-weight: 700; letter-spacing: -0.02em; }
    p { margin: 0 0 1rem; color: #64748b; font-size: 0.9375rem; }
    label { display: block; margin-bottom: 0.25rem; font-weight: 500; font-size: 0.9375rem; }
    input[type="password"] { width: 100%; box-sizing: border-box; padding: 0.75rem; border: 1px solid #e2e8f0; border-radius: 0.5rem; font-size: 0.9375rem; margin-bottom: 0.75rem; background: #ffffff; color: #0f172a; }
    input[type="password"]:focus { border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1); outline: none; }
    button { padding: 0.75rem 1.5rem; background: #2563eb; color: #ffffff; border: none; border-radius: 0.5rem; font-size: 0.9375rem; font-weight: 500; cursor: pointer; line-height: 1.25; }
    button:hover { background: #1d4ed8; }
    .error { color: #dc2626; font-weight: 500; margin-bottom: 1rem; padding: 0.75rem; background: #fef2f2; border-radius: 0.5rem; font-size: 0.9375rem; }
    @media (prefers-color-scheme: dark) { body { background: #0b1220; color: #f1f5f9; } main { background: #16213a; box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.3), 0 4px 6px -1px rgb(0 0 0 / 0.4), 0 2px 4px -2px rgb(0 0 0 / 0.4); } p { color: #94a3b8; } input[type="password"] { background: #16213a; color: #f1f5f9; border-color: #2b3a55; } input[type="password"]:focus { border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.16); } button { background: #3b82f6; } button:hover { background: #60a5fa; } .error { background: rgba(220, 38, 38, 0.18); color: #f87171; } }
  </style>
</head>
<body>
  <main>
    <h1>${name}</h1>
    <p>This page is password protected.</p>${errorBlock}
    <form method="post" action="${actionAttr}">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" required minlength="5" autocomplete="current-password">
      <button type="submit">Unlock</button>
    </form>
  </main>
</body>
</html>
`;
}
