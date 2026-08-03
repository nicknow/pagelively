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
    body { font-family: system-ui, sans-serif; line-height: 1.5; margin: 0; padding: 2rem 1rem; }
    main { max-width: 24rem; margin: 0 auto; }
    label { display: block; margin-bottom: 0.25rem; }
    input[type="password"] { width: 100%; box-sizing: border-box; padding: 0.5rem; margin-bottom: 0.75rem; }
    button { padding: 0.5rem 1rem; }
    .error { color: #b00020; }
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
