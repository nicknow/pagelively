/**
 * S19 — Admin UI handlers (buildless HTML dashboard, upload, edit).
 *
 * Pure HTML/CSS/JS served from the Worker: no bundler, no framework, no external
 * CDN. Inline strings are small enough to keep the bundle within the Workers free
 * limit (spec §15, risk R5). The UI posts to the admin API endpoints implemented in
 * S15/S17/S18; the same Access JWT verification gate protects /admin* and /api* at the
 * edge and in the Worker (S16, ADR 0024).
 */

import { AppError } from "./errors";
import { validateId } from "./ids";
import { escapeHtml } from "./utils";
import { isProtectedEntryPath } from "./admin-api";
import type { AppConfig } from "./config";
import type { CacheService } from "./cache-service";
import type { PagesRepository, PageRecord } from "./pages-repository";
import type { FilesRepository, FileRecord } from "./files-repository";
import type { ObjectStore } from "./object-store";
import type { VerifiedIdentity } from "./access-verify";
import type { SettingsRepository } from "./settings-repository";

export interface AdminUiDeps {
  config: AppConfig;
  cacheService: CacheService;
  pagesRepository: PagesRepository;
  filesRepository: FilesRepository;
  objectStore: ObjectStore;
  verifiedIdentity: VerifiedIdentity;
  settingsRepository?: SettingsRepository;
  tagsRepository?: import("./tags-repository").TagsRepository;
}

function adminHtmlHeaders(cacheService: CacheService): Headers {
  const headers = cacheService.headersFor("admin");
  headers.set("Content-Type", "text/html; charset=utf-8");
  return headers;
}

function htmlResponse(cacheService: CacheService, body: string, status = 200): Response {
  return new Response(body, { status, headers: adminHtmlHeaders(cacheService) });
}

function pageTitle(config: AppConfig): string {
  return `${config.siteName} — Admin`;
}

const DESIGN_SYSTEM_CSS = `
:root {
  color-scheme: light;
  --color-bg: #f8fafc;
  --color-surface: #ffffff;
  --color-surface-raised: #f1f5f9;
  --color-text: #0f172a;
  --color-text-muted: #64748b;
  --color-primary: #2563eb;
  --color-primary-hover: #1d4ed8;
  --color-primary-bg: #eff6ff;
  --color-danger: #dc2626;
  --color-danger-hover: #b91c1c;
  --color-danger-bg: #fef2f2;
  --color-success: #16a34a;
  --color-warning: #ca8a04;
  --color-border: #e2e8f0;
  --color-focus: #3b82f6;
  --radius-sm: 0.25rem;
  --radius-md: 0.5rem;
  --radius-lg: 0.75rem;
  --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
  --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.25rem;
  --space-6: 1.5rem;
  --space-8: 2rem;
  --space-10: 2.5rem;
  --font-sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --max-width: 1100px;
  --transition-fast: 0.15s ease;
  --transition-base: 0.2s ease;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --color-bg: #0b1220;
    --color-surface: #16213a;
    --color-surface-raised: #1e293b;
    --color-text: #f1f5f9;
    --color-text-muted: #94a3b8;
    --color-primary: #3b82f6;
    --color-primary-hover: #60a5fa;
    --color-primary-bg: rgba(59, 130, 246, 0.16);
    --color-danger: #f87171;
    --color-danger-hover: #fca5a5;
    --color-danger-bg: rgba(220, 38, 38, 0.18);
    --color-success: #4ade80;
    --color-warning: #facc15;
    --color-border: #2b3a55;
    --color-focus: #60a5fa;
    --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.3);
    --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.4), 0 2px 4px -2px rgb(0 0 0 / 0.4);
    --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.5), 0 4px 6px -4px rgb(0 0 0 / 0.5);
  }
}

:root[data-theme="dark"] {
  color-scheme: dark;
  --color-bg: #0b1220;
  --color-surface: #16213a;
  --color-surface-raised: #1e293b;
  --color-text: #f1f5f9;
  --color-text-muted: #94a3b8;
  --color-primary: #3b82f6;
  --color-primary-hover: #60a5fa;
  --color-primary-bg: rgba(59, 130, 246, 0.16);
  --color-danger: #f87171;
  --color-danger-hover: #fca5a5;
  --color-danger-bg: rgba(220, 38, 38, 0.18);
  --color-success: #4ade80;
  --color-warning: #facc15;
  --color-border: #2b3a55;
  --color-focus: #60a5fa;
  --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.3);
  --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.4), 0 2px 4px -2px rgb(0 0 0 / 0.4);
  --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.5), 0 4px 6px -4px rgb(0 0 0 / 0.5);
}

:root[data-theme="light"] {
  color-scheme: light;
  --color-bg: #f8fafc;
  --color-surface: #ffffff;
  --color-surface-raised: #f1f5f9;
  --color-text: #0f172a;
  --color-text-muted: #64748b;
  --color-primary: #2563eb;
  --color-primary-hover: #1d4ed8;
  --color-primary-bg: #eff6ff;
  --color-danger: #dc2626;
  --color-danger-hover: #b91c1c;
  --color-danger-bg: #fef2f2;
  --color-success: #16a34a;
  --color-warning: #ca8a04;
  --color-border: #e2e8f0;
  --color-focus: #3b82f6;
  --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
  --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}

* { box-sizing: border-box; }

html { scroll-behavior: smooth; }

body {
  font-family: var(--font-sans);
  margin: 0;
  padding: 0;
  background: var(--color-bg);
  color: var(--color-text);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

:focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 2px;
}

button:focus-visible,
a:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible {
  outline-offset: 2px;
}

.hidden {
  display: none !important;
}

.icon { vertical-align: middle; flex-shrink: 0; }

header {
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-border);
  box-shadow: var(--shadow-sm);
  padding: var(--space-4) var(--space-4);
  position: sticky;
  top: 0;
  z-index: 100;
}

.header-inner {
  max-width: var(--max-width);
  margin: 0 auto;
  padding: 0 var(--space-4);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.container {
  max-width: var(--max-width);
  margin: 0 auto;
  padding: 0 var(--space-4);
}

header h1 {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

header .identity {
  color: var(--color-text-muted);
  font-size: 0.875rem;
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
  max-width: 200px;
}

main {
  padding: var(--space-8) 0;
}

.card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  padding: var(--space-6);
  margin-bottom: var(--space-6);
}

.card > header,
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
  margin-bottom: var(--space-5);
}

.card > header h2,
.section-header h2,
.section-header h3 {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-5);
  border-radius: var(--radius-md);
  border: 1px solid transparent;
  font-size: 0.9375rem;
  font-weight: 500;
  line-height: 1.25;
  text-decoration: none;
  cursor: pointer;
  transition: background-color var(--transition-fast), border-color var(--transition-fast), box-shadow var(--transition-fast);
}

.button-primary {
  background: var(--color-primary);
  color: #fff;
  border-color: var(--color-primary);
}

.button-primary:hover {
  background: var(--color-primary-hover);
  border-color: var(--color-primary-hover);
}

.button-secondary {
  background: var(--color-surface);
  color: var(--color-primary);
  border-color: var(--color-border);
}

.button-secondary:hover {
  background: var(--color-primary-bg);
  border-color: var(--color-primary);
}

.button-danger {
  background: var(--color-danger);
  color: #fff;
  border-color: var(--color-danger);
}

.button-danger:hover {
  background: var(--color-danger-hover);
  border-color: var(--color-danger-hover);
}

.button-small {
  padding: var(--space-2) var(--space-3);
  font-size: 0.875rem;
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-3);
  border-radius: 9999px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  white-space: nowrap;
}

.kind-html { background: #dbeafe; color: #1e40af; }
.kind-markdown { background: #dcfce7; color: #166534; }
.kind-image { background: #f3e8ff; color: #6b21a8; }
.kind-bundle { background: #ffedd5; color: #9a3412; }

.visibility-public { background: #dcfce7; color: #166534; }
.visibility-unlisted { background: #f1f5f9; color: #475569; }

.protected {
  background: var(--color-danger-bg);
  color: var(--color-danger);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .kind-html { background: rgba(30, 64, 175, 0.25); color: #93c5fd; }
  :root:not([data-theme="light"]) .kind-markdown { background: rgba(22, 101, 52, 0.25); color: #86efac; }
  :root:not([data-theme="light"]) .kind-image { background: rgba(107, 33, 168, 0.25); color: #c4b5fd; }
  :root:not([data-theme="light"]) .kind-bundle { background: rgba(154, 52, 18, 0.25); color: #fdba74; }
  :root:not([data-theme="light"]) .visibility-public { background: rgba(22, 101, 52, 0.25); color: #86efac; }
  :root:not([data-theme="light"]) .visibility-unlisted { background: rgba(71, 85, 105, 0.25); color: #cbd5e1; }
  :root:not([data-theme="light"]) .protected { background: rgba(220, 38, 38, 0.25); color: #fca5a5; }
}

:root[data-theme="dark"] .kind-html { background: rgba(30, 64, 175, 0.25); color: #93c5fd; }
:root[data-theme="dark"] .kind-markdown { background: rgba(22, 101, 52, 0.25); color: #86efac; }
:root[data-theme="dark"] .kind-image { background: rgba(107, 33, 168, 0.25); color: #c4b5fd; }
:root[data-theme="dark"] .kind-bundle { background: rgba(154, 52, 18, 0.25); color: #fdba74; }
:root[data-theme="dark"] .visibility-public { background: rgba(22, 101, 52, 0.25); color: #86efac; }
:root[data-theme="dark"] .visibility-unlisted { background: rgba(71, 85, 105, 0.25); color: #cbd5e1; }
:root[data-theme="dark"] .protected { background: rgba(220, 38, 38, 0.25); color: #fca5a5; }

.empty {
  text-align: center;
  padding: var(--space-10) var(--space-6);
  color: var(--color-text-muted);
}

.empty p {
  margin: 0 0 var(--space-4);
  font-size: 1.125rem;
}

.empty .hint {
  margin-bottom: var(--space-6);
}

.table-wrapper {
  overflow-x: auto;
  margin: 0 calc(var(--space-6) * -1);
  padding: 0 var(--space-6);
}

.page-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9375rem;
}

.page-table th {
  text-align: left;
  padding: var(--space-3) var(--space-4);
  color: var(--color-text-muted);
  font-weight: 600;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-bottom: 1px solid var(--color-border);
  white-space: nowrap;
}

.page-table td {
  padding: var(--space-4);
  border-bottom: 1px solid var(--color-border);
  vertical-align: middle;
}

.page-table tbody tr:last-child td {
  border-bottom: none;
}

.page-table tbody tr:hover {
  background: var(--color-surface-raised);
}

.page-table td .title {
  font-weight: 500;
  color: var(--color-text);
}

.actions {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.form-group {
  margin-bottom: var(--space-5);
}

.field-label {
  display: block;
  font-weight: 500;
  margin-bottom: var(--space-2);
  color: var(--color-text);
}

.hint {
  display: block;
  color: var(--color-text-muted);
  font-size: 0.875rem;
  font-weight: 400;
  margin-top: var(--space-1);
}

input[type="text"],
input[type="file"],
select,
textarea {
  width: 100%;
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  font-size: 0.9375rem;
  background: var(--color-surface);
  color: var(--color-text);
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}

input[type="text"]:focus,
select:focus,
textarea:focus {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-bg);
  outline: none;
}

input[type="file"] {
  padding: var(--space-2);
}

.radio-group {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-5);
  align-items: center;
}

.radio-group label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-weight: 400;
  cursor: pointer;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  cursor: pointer;
  font-weight: 400;
}

.checkbox-label input {
  width: auto;
}

.slug-preview {
  display: block;
  margin-top: var(--space-2);
  font-size: 0.875rem;
  color: var(--color-text-muted);
  min-height: 1.25rem;
}

.error-box {
  display: none;
  background: var(--color-danger-bg);
  color: var(--color-danger);
  border: 1px solid #fecaca;
  border-radius: var(--radius-md);
  padding: var(--space-4);
  margin-bottom: var(--space-5);
}

.error-box.visible {
  display: block;
}

.tab-bar {
  display: flex;
  gap: var(--space-1);
  border-bottom: 1px solid var(--color-border);
  margin-bottom: var(--space-6);
}

.tab {
  padding: var(--space-3) var(--space-5);
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-weight: 500;
  font-size: 0.9375rem;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  border-radius: var(--radius-md) var(--radius-md) 0 0;
  transition: color var(--transition-fast), background-color var(--transition-fast);
}

.tab:hover {
  color: var(--color-text);
  background: var(--color-surface-raised);
}

.tab.active {
  color: var(--color-primary);
  background: var(--color-primary-bg);
  border-bottom-color: var(--color-primary);
}

.tab-pane {
  display: none;
}

.tab-pane.active {
  display: block;
}

.file-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.file-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-3);
  background: var(--color-surface);
  flex-wrap: wrap;
}

.file-meta {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  min-width: 0;
}

.file-path {
  font-family: var(--font-mono);
  font-size: 0.875rem;
  color: var(--color-text);
  word-break: break-all;
}

.file-hint {
  color: var(--color-text-muted);
  font-size: 0.875rem;
  margin-bottom: var(--space-5);
}

.toast-container {
  position: fixed;
  top: var(--space-4);
  right: var(--space-4);
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-width: 360px;
  width: calc(100% - var(--space-8));
}

.toast {
  background: var(--color-surface);
  border-left: 4px solid var(--color-primary);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  padding: var(--space-4) var(--space-5);
  transform: translateX(120%);
  opacity: 0;
  transition: transform 0.3s ease, opacity 0.3s ease;
  pointer-events: auto;
  word-break: break-word;
}

.toast.show {
  transform: translateX(0);
  opacity: 1;
}

.toast-error { border-left-color: var(--color-danger); }
.toast-success { border-left-color: var(--color-success); }

@media (max-width: 640px) {
  .header-inner,
  .container {
    padding: 0 var(--space-3);
  }

  .card {
    padding: var(--space-5) var(--space-4);
    border-radius: var(--radius-md);
  }

  .page-table thead {
    display: none;
  }

  .page-table tbody,
  .page-table tr,
  .page-table td {
    display: block;
  }

  .page-table tr {
    margin-bottom: var(--space-4);
    padding: var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }

  .page-table td {
    border: none;
    padding: var(--space-2) 0;
  }

  .page-table td::before {
    content: attr(data-label);
    font-weight: 600;
    color: var(--color-text-muted);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .page-table td.title-cell::before {
    display: none;
  }

  .page-table td.actions-cell {
    padding-top: var(--space-4);
    border-top: 1px solid var(--color-border);
    margin-top: var(--space-3);
  }

  .actions-cell .actions {
    width: 100%;
  }

  .actions-cell .actions .button {
    flex: 1 1 auto;
  }

  .tab-bar {
    overflow-x: auto;
  }

  .radio-group {
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-3);
  }
}

.dropzone {
  position: relative;
  border: 2px dashed var(--color-border);
  border-radius: var(--radius-lg);
  padding: var(--space-8);
  text-align: center;
  transition: border-color var(--transition-fast), background-color var(--transition-fast);
  margin-bottom: var(--space-5);
}

.dropzone:hover {
  border-color: var(--color-primary);
  background: var(--color-primary-bg);
}

.dropzone.drag-active {
  border-color: var(--color-primary);
  background: var(--color-primary-bg);
}

.dropzone .dz-label {
  display: block;
  font-weight: 500;
  margin-bottom: var(--space-2);
  color: var(--color-text);
}

.dropzone .dz-hint {
  display: block;
  font-size: 0.875rem;
  color: var(--color-text-muted);
  margin-top: var(--space-1);
}

.folder-toggle {
  display: inline-block;
  margin-top: var(--space-2);
  font-size: 0.875rem;
  color: var(--color-primary);
  cursor: pointer;
  text-decoration: underline;
  border: none;
  background: none;
  padding: 0;
}

.folder-toggle:hover {
  color: var(--color-primary-hover);
}

.folder-dropzone-wrapper { display: none; }

.folder-dropzone-wrapper.visible { display: block; }

.file-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.file-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  background: var(--color-surface-raised);
  border-radius: var(--radius-md);
  font-size: 0.8125rem;
}

.file-chip .chip-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  color: var(--color-danger);
  cursor: pointer;
  border-radius: var(--radius-sm);
  padding: 0;
}

.file-chip .chip-remove:hover {
  color: var(--color-danger-hover);
  background: var(--color-danger-bg);
}

.page-nav {
  margin-bottom: var(--space-4);
  display: flex;
  align-items: center;
}

.page-nav a {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--color-text-muted);
  text-decoration: none;
  font-size: 0.9375rem;
  font-weight: 500;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  transition: color var(--transition-fast), background-color var(--transition-fast);
}

.page-nav a:hover {
  color: var(--color-text);
  background: var(--color-surface-raised);
}
`;

const SHARED_JS = `<script>
  function showToast(message, type) {
    type = type || 'error';
    var container = document.getElementById('toast-container');
    if (!container || !message) return;
    var toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.innerHTML = '';
    var iconSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    iconSvg.setAttribute('class', 'icon');
    iconSvg.setAttribute('width', '18');
    iconSvg.setAttribute('height', '18');
    iconSvg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttributeNS('http://www.w3.org/1999/xlink', 'href', '#icon-' + (type === 'success' ? 'check-circle' : 'alert-circle'));
    iconSvg.appendChild(use);
    toast.appendChild(iconSvg);
    var msgSpan = document.createElement('span');
    msgSpan.textContent = message;
    toast.appendChild(msgSpan);
    container.appendChild(toast);
    requestAnimationFrame(function() { toast.classList.add('show'); });
    setTimeout(function() {
      toast.classList.remove('show');
      setTimeout(function() { toast.remove(); }, 300);
    }, 5000);
  }

  function updateSlugPreview(input, preview) {
    var raw = input.value || '';
    var cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    if (preview) {
      preview.textContent = cleaned ? 'URL: /' + cleaned + '/' : '';
    }
  }

  function initSlugPreview(inputId, previewId) {
    var input = document.getElementById(inputId);
    var preview = document.getElementById(previewId);
    if (!input || !preview) return;
    updateSlugPreview(input, preview);
    input.addEventListener('input', function() { updateSlugPreview(input, preview); });
  }

  function formatDateTime(isoString) {
    try {
      var d = new Date(isoString);
      if (isNaN(d.getTime())) return isoString;
      return d.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
    } catch(e) { return isoString; }
  }

  function toggleTheme() {
    var current = document.documentElement.getAttribute('data-theme');
    var isDark = current === 'dark' || (!current && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var next = isDark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('pl-theme', next);
    document.querySelectorAll('[data-theme-toggle]').forEach(function(btn) {
      btn.setAttribute('aria-pressed', next === 'dark' ? 'true' : 'false');
      btn.innerHTML = '<svg class="icon" width="20" height="20" aria-hidden="true"><use href="#icon-' + (next === 'dark' ? 'moon' : 'sun') + '"></use></svg>';
    });
  }

  document.addEventListener('DOMContentLoaded', function() {
    var btn = document.querySelector('[data-theme-toggle]');
    if (btn) {
      var current = document.documentElement.getAttribute('data-theme');
      var isDark = current === 'dark' || (!current && window.matchMedia('(prefers-color-scheme: dark)').matches);
      btn.setAttribute('aria-pressed', isDark ? 'true' : 'false');
      btn.innerHTML = '<svg class="icon" width="20" height="20" aria-hidden="true"><use href="#icon-' + (isDark ? 'sun' : 'moon') + '"></use></svg>';
      btn.addEventListener('click', toggleTheme);
    }
    document.querySelectorAll('time[datetime]').forEach(function(el) {
      el.textContent = formatDateTime(el.getAttribute('datetime'));
    });
  });
</script>`;

const ICON_SPRITE = `<svg style="display:none" aria-hidden="true">
  <symbol id="icon-brand-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <rect x="6" y="4" width="12" height="16" rx="2" /><rect x="8" y="6" width="8" height="12" rx="1" />
  </symbol>
  <symbol id="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </symbol>
  <symbol id="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </symbol>
  <symbol id="icon-upload" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M12 3v12M9 6l3-3 3 3" />
  </symbol>
  <symbol id="icon-folder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </symbol>
  <symbol id="icon-file" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><polyline points="13 2 13 9 20 9" />
  </symbol>
  <symbol id="icon-file-html" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><polyline points="13 2 13 9 20 9" /><path d="M9 14l-2 2 2 2M15 14l2 2-2 2M12 13l-1 4" />
  </symbol>
  <symbol id="icon-file-markdown" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><polyline points="13 2 13 9 20 9" /><path d="M9 15l2-3 2 3M13 15v-4" />
  </symbol>
  <symbol id="icon-file-image" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><polyline points="13 2 13 9 20 9" /><circle cx="10" cy="12" r="1.5" /><path d="M7 18l3-4 2 2 2-2 3 4" />
  </symbol>
  <symbol id="icon-file-bundle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><polyline points="13 2 13 9 20 9" /><rect x="9" y="12" width="6" height="2" /><rect x="9" y="16" width="4" height="2" />
  </symbol>
  <symbol id="icon-eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
  </symbol>
  <symbol id="icon-pencil" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
  </symbol>
  <symbol id="icon-trash" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
  </symbol>
  <symbol id="icon-lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </symbol>
  <symbol id="icon-check-circle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10" /><polyline points="8 12 11 15 16 9" />
  </symbol>
  <symbol id="icon-alert-circle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
  </symbol>
  <symbol id="icon-arrow-left" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
  </symbol>
  <symbol id="icon-settings" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </symbol>
  <symbol id="icon-inbox" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" /><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </symbol>
</svg>`;

function layout(config: AppConfig, verifiedIdentity: VerifiedIdentity, content: string): string {
  const email = escapeHtml(verifiedIdentity.email ?? "unknown");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <script>(function(){try{var t=localStorage.getItem('pl-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);}catch(e){}})()</script>
  <title>${escapeHtml(pageTitle(config))}</title>
  <style>
${DESIGN_SYSTEM_CSS}
  </style>
  ${SHARED_JS}
</head>
<body>
  <div id="toast-container" class="toast-container" role="status" aria-live="polite"></div>
  <header>
    <div class="header-inner">
      <h1><svg class="icon" width="20" height="20" aria-hidden="true"><use href="#icon-brand-mark"></use></svg>${escapeHtml(config.siteName)}</h1>
      <span class="identity">${email}</span>
      <button data-theme-toggle class="button button-small" type="button" aria-label="Toggle color theme" aria-pressed="false" style="width:44px;height:44px;display:flex;align-items:center;justify-content:center;padding:0;flex-shrink:0;">
        <svg class="icon" width="20" height="20" aria-hidden="true"><use href="#icon-sun"></use></svg>
      </button>
    </div>
  </header>
  <main>
    <div class="container">
      ${content}
    </div>
  </main>
  ${ICON_SPRITE}
</body>
</html>`;
}

function dashboardContent(config: AppConfig, pages: PageRecord[], requestUrl: URL): string {
  const uploadUrl = new URL("/admin/upload", requestUrl).pathname;
  const rows = pages
    .map((page) => {
      const viewUrl = page.slug ? `/${page.slug}/` : `/p/${page.id}/`;
      const editUrl = `/admin/edit/${page.id}`;
      const deleteUrl = `/api/pages/${page.id}`;
      const kindIconMap: Record<string, string> = {
        html: "file-html",
        markdown: "file-markdown",
        image: "file-image",
        bundle: "file-bundle",
      };
      const kindIcon = kindIconMap[page.kind] ?? "file";
      const kindSvg = `<svg class="icon" width="16" height="16" aria-hidden="true"><use href="#icon-${kindIcon}"></use></svg>`;
      return `<tr>
        <td class="title-cell">
          <div class="title">${escapeHtml(page.title)}</div>
        </td>
        <td data-label="Kind"><span class="badge kind-${escapeHtml(page.kind)}">${kindSvg}${escapeHtml(page.kind)}</span></td>
        <td data-label="Visibility"><span class="badge visibility-${escapeHtml(page.visibility)}">${escapeHtml(page.visibility)}</span></td>
        <td data-label="Created"><time datetime="${escapeHtml(page.created_at)}">${escapeHtml(page.created_at)}</time></td>
        <td class="actions-cell" data-label="Actions">
          <div class="actions">
            <a class="button button-secondary button-small" href="${escapeHtml(viewUrl)}">View</a>
            <a class="button button-secondary button-small" href="${escapeHtml(editUrl)}">Edit</a>
            <button class="button button-danger button-small" type="button" data-delete="${escapeHtml(deleteUrl)}">Delete</button>
          </div>
        </td>
      </tr>`;
    })
    .join("\n");

  const table =
    pages.length === 0
      ? `<div class="empty">
        <svg class="icon" width="48" height="48" aria-hidden="true" style="color:var(--color-text-muted);margin-bottom:var(--space-4)"><use href="#icon-inbox"></use></svg>
        <p>No pages yet.</p>
        <p class="hint">Create your first page to get started.</p>
        <a class="button button-primary" href="${escapeHtml(uploadUrl)}">Upload your first page</a>
      </div>`
      : `<div class="table-wrapper">
        <table class="page-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Kind</th>
              <th>Visibility</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;

  return `<div class="card">
    <header>
      <h2>Pages</h2>
      <div class="toolbar">
        <a class="button button-secondary button-small" href="/admin/settings"><svg class="icon" width="16" height="16" aria-hidden="true"><use href="#icon-settings"></use></svg>Settings</a>
        <a class="button button-primary" href="${escapeHtml(uploadUrl)}"><svg class="icon" width="20" height="20" aria-hidden="true"><use href="#icon-upload"></use></svg>Upload</a>
      </div>
    </header>
    ${table}
  </div>
  <script>
    document.querySelectorAll('[data-delete]').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        if (!confirm('Delete this page and all its files? This cannot be undone.')) return;
        const res = await fetch(btn.dataset.delete, { method: 'DELETE' });
        if (res.ok) {
          window.location.reload();
        } else {
          const body = await res.json().catch(function() { return { error: 'Delete failed' }; });
          showToast(body.message || body.error || 'Delete failed', 'error');
        }
      });
    });
  </script>`;
}

export async function handleAdminDashboard(
  request: Request,
  _ctx: ExecutionContext,
  deps: AdminUiDeps,
): Promise<Response> {
  const { pagesRepository, cacheService, config, verifiedIdentity } = deps;
  const pages = await pagesRepository.list();
  const url = new URL(request.url);
  const content = dashboardContent(config, pages, url);
  const body = layout(config, verifiedIdentity, content);
  return htmlResponse(cacheService, body);
}

function uploadContent(): string {
  const backUrl = "/admin";
  return `<div class="page-nav">
    <a href="${escapeHtml(backUrl)}"><svg class="icon" width="20" height="20" aria-hidden="true"><use href="#icon-arrow-left"></use></svg>Back</a>
  </div>
  <div class="card">
    <header>
      <h2>Upload a page</h2>
    </header>
    <div class="error-box" id="upload-error" role="alert"></div>
    <div class="tab-bar" role="tablist">
      <button type="button" class="tab active" role="tab" data-tab="upload" aria-selected="true">Upload files</button>
      <button type="button" class="tab" role="tab" data-tab="paste" aria-selected="false">Paste content</button>
    </div>

    <div id="upload-pane" class="tab-pane active" role="tabpanel">
      <!-- Multipart convention: manifest JSON field + file:<path> file parts -->
      <form id="upload-form" action="/api/pages" method="POST" enctype="multipart/form-data">
        <div class="form-group">
          <label class="field-label">Files</label>
          <div class="dropzone" id="files-dropzone">
            <input type="file" name="files" id="files" multiple style="position:absolute;inset:0;opacity:0;cursor:pointer;">
            <svg class="icon" width="48" height="48" aria-hidden="true" style="color:var(--color-text-muted);margin-bottom:var(--space-3)"><use href="#icon-upload"></use></svg>
            <span class="dz-label">Drag files here or click to browse</span>
            <span class="dz-hint">Choose one or more loose files.</span>
          </div>
          <div class="file-chips" id="upload-chips"></div>
        </div>
        <div class="form-group">
          <label class="field-label">Folder upload</label>
          <div class="folder-dropzone-wrapper" id="folder-dropzone-wrapper">
            <div class="dropzone" id="folder-dropzone">
              <input type="file" name="folder" id="folder" multiple webkitdirectory style="position:absolute;inset:0;opacity:0;cursor:pointer;">
              <svg class="icon" width="48" height="48" aria-hidden="true" style="color:var(--color-text-muted);margin-bottom:var(--space-3)"><use href="#icon-folder"></use></svg>
              <span class="dz-label">Upload entire folder</span>
              <span class="dz-hint">Preserves relative paths inside the selected folder.</span>
            </div>
            <div class="file-chips" id="folder-chips"></div>
          </div>
          <button type="button" class="folder-toggle" id="folder-toggle">Uploading a folder instead?</button>
        </div>
        <div class="form-group">
          <label class="field-label" for="slug">Slug <span class="hint">(optional)</span></label>
          <input type="text" name="slug" id="slug" placeholder="my-page">
          <span class="slug-preview" id="slug-preview"></span>
        </div>
        <div class="form-group">
          <label class="field-label" for="title">Title <span class="hint">(optional; defaults to filename)</span></label>
          <input type="text" name="title" id="title" placeholder="My Page">
        </div>
        <div class="form-group">
          <span class="field-label">Visibility</span>
          <div class="radio-group">
            <label><input type="radio" name="visibility" value="public" checked> Public</label>
            <label><input type="radio" name="visibility" value="unlisted"> Unlisted</label>
          </div>
        </div>
        <div class="form-group">
          <label class="checkbox-label">
            <input type="checkbox" name="show_source" id="show_source" value="true">
            Show source link (for Markdown pages)
          </label>
        </div>
        <div id="entry-field" class="hidden">
          <div class="form-group">
            <label class="field-label" for="entry">Entry file</label>
            <select name="entry" id="entry"></select>
            <span class="hint">Which file is the page entry?</span>
          </div>
        </div>
        <div class="form-group">
          <span class="field-label">Page kind</span>
          <div class="radio-group">
            <label><input type="radio" name="page-kind" value="regular" checked data-kind-regular> Regular page</label>
            <label><input type="radio" name="page-kind" value="listing" data-kind-listing> Listing page</label>
          </div>
        </div>
        <div id="listing-page-fields" class="hidden">
          <div class="form-group">
            <label class="field-label" for="listing-match-tags">Match tags <span class="hint">Show all public pages that match ANY of these tags (comma-separated)</span></label>
            <input type="text" name="listing-match-tags" id="listing-match-tags" placeholder="blog, tech, announcement">
          </div>
        </div>
        <div id="regular-page-fields">
        <div class="form-group">
          <label class="field-label" for="tags">Tags <span class="hint">(optional, comma-separated)</span></label>
          <input type="text" name="tags" id="tags" placeholder="blog, tech, announcement">
        </div>
        </div>
        <div class="form-group">
          <label class="field-label" for="password">Password <span class="hint">(optional)</span></label>
          <input type="password" name="password" id="password" minlength="5" placeholder="Set a page password">
          <p id="password-notice" style="display:none">All access will bypass the CDN which may increase usage.</p>
        </div>
        <input type="hidden" name="manifest" id="manifest">
        <div class="toolbar">
          <button type="submit" class="button button-primary">Upload</button>
        </div>
      </form>
    </div>

    <div id="paste-pane" class="tab-pane" role="tabpanel">
      <form id="paste-form" action="/api/pages">
        <div class="form-group">
          <label class="field-label" for="paste-content">Content</label>
          <textarea name="content" id="paste-content" rows="12" placeholder="Paste HTML or Markdown here"></textarea>
          <span class="hint">Paste HTML or Markdown content. It will be published as a single page.</span>
        </div>
        <div class="form-group">
          <span class="field-label">Format</span>
          <div class="radio-group">
            <label><input type="radio" name="paste-format" value="html"> HTML</label>
            <label><input type="radio" name="paste-format" value="markdown" checked> Markdown</label>
          </div>
        </div>
        <div class="form-group">
          <label class="field-label" for="paste-slug">Slug <span class="hint">(optional)</span></label>
          <input type="text" name="paste-slug" id="paste-slug" placeholder="my-page">
          <span class="slug-preview" id="paste-slug-preview"></span>
        </div>
        <div class="form-group">
          <label class="field-label" for="paste-title">Title <span class="hint">(optional)</span></label>
          <input type="text" name="paste-title" id="paste-title" placeholder="My Page">
        </div>
        <div class="form-group">
          <span class="field-label">Visibility</span>
          <div class="radio-group">
            <label><input type="radio" name="paste-visibility" value="public" checked> Public</label>
            <label><input type="radio" name="paste-visibility" value="unlisted"> Unlisted</label>
          </div>
        </div>
        <div class="form-group">
          <label class="checkbox-label">
            <input type="checkbox" name="paste-show-source" id="paste-show-source" value="true">
            Show source link (for Markdown pages)
          </label>
        </div>
        <div class="form-group">
          <span class="field-label">Page kind</span>
          <div class="radio-group">
            <label><input type="radio" name="paste-page-kind" value="regular" checked data-kind-regular> Regular page</label>
            <label><input type="radio" name="paste-page-kind" value="listing" data-kind-listing> Listing page</label>
          </div>
        </div>
        <div id="paste-listing-fields" class="hidden">
          <div class="form-group">
            <label class="field-label" for="paste-match-tags">Match tags <span class="hint">Show all public pages that match ANY of these tags (comma-separated)</span></label>
            <input type="text" name="paste-match-tags" id="paste-match-tags" placeholder="blog, tech, announcement">
          </div>
        </div>
        <div id="paste-regular-fields">
        <div class="form-group">
          <label class="field-label" for="paste-tags">Tags <span class="hint">(optional, comma-separated)</span></label>
          <input type="text" name="paste-tags" id="paste-tags" placeholder="blog, tech, announcement">
        </div>
        </div>
        <div class="form-group">
          <label class="field-label" for="paste-password">Password <span class="hint">(optional)</span></label>
          <input type="password" name="paste-password" id="paste-password" minlength="5" placeholder="Set a page password">
          <p id="paste-password-notice" style="display:none">All access will bypass the CDN which may increase usage.</p>
        </div>
        <div class="toolbar">
          <button type="submit" id="publish-paste" class="button button-primary">Publish</button>
        </div>
      </form>
    </div>
  </div>
  <script>
    (function() {
      const form = document.getElementById('upload-form');
      const pasteForm = document.getElementById('paste-form');
      const filesInput = document.getElementById('files');
      const folderInput = document.getElementById('folder');
      const manifestInput = document.getElementById('manifest');
      const entryField = document.getElementById('entry-field');
      const entrySelect = document.getElementById('entry');
      const errorBox = document.getElementById('upload-error');
      const pasteContent = document.getElementById('paste-content');
      const tabs = document.querySelectorAll('[data-tab]');
      const panes = { upload: document.getElementById('upload-pane'), paste: document.getElementById('paste-pane') };
      const documentExts = ['.html', '.htm', '.md', '.markdown'];

      initSlugPreview('slug', 'slug-preview');
      initSlugPreview('paste-slug', 'paste-slug-preview');

      function initPasswordNotice(inputId, noticeId) {
        var input = document.getElementById(inputId);
        var notice = document.getElementById(noticeId);
        if (!input || !notice) return;
        input.addEventListener('input', function() {
          notice.style.display = input.value ? 'block' : 'none';
        });
      }
      initPasswordNotice('password', 'password-notice');
      initPasswordNotice('paste-password', 'paste-password-notice');

      function showTab(tab) {
        tabs.forEach(function(t) {
          const active = t.dataset.tab === tab;
          t.classList.toggle('active', active);
          t.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        Object.keys(panes).forEach(function(k) {
          panes[k].classList.toggle('active', k === tab);
        });
        errorBox.classList.remove('visible');
        errorBox.textContent = '';
      }

      tabs.forEach(function(t) {
        t.addEventListener('click', function() { showTab(t.dataset.tab); });
      });

      var managedFiles = [];

      function selectedFiles() {
        return managedFiles;
      }

      function isDocument(name) {
        const lower = name.toLowerCase();
        return documentExts.some(ext => lower.endsWith(ext));
      }

      function isImage(name) {
        const lower = name.toLowerCase();
        return /\\.(png|jpg|jpeg|gif|webp|svg|avif)$/.test(lower);
      }

      function escapeHtml(str) {
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
      }

      function renderChips(containerId, source) {
        var container = document.getElementById(containerId);
        if (!container) return;
        if (source.length === 0) { container.innerHTML = ''; return; }
        container.innerHTML = source.map(function(item, index) {
          var icon = 'file';
          var lower = item.path.toLowerCase();
          if (lower.endsWith('.html') || lower.endsWith('.htm')) icon = 'file-html';
          else if (lower.endsWith('.md') || lower.endsWith('.markdown')) icon = 'file-markdown';
          else if (lower.match(/\\.(png|jpg|jpeg|gif|webp|svg|avif)$/)) icon = 'file-image';
          return '<span class="file-chip">' +
            '<svg class="icon" width="16" height="16" aria-hidden="true"><use href="#icon-' + icon + '"></use></svg> ' +
            escapeHtml(item.path) +
            '<button type="button" class="chip-remove" data-chip-index="' + index + '" aria-label="Remove ' + escapeHtml(item.path) + '">' +
            '<svg class="icon" width="14" height="14" aria-hidden="true"><use href="#icon-trash"></use></svg></button></span>';
        }).join('');
        container.querySelectorAll('.chip-remove').forEach(function(btn) {
          btn.addEventListener('click', function() {
            var idx = parseInt(btn.dataset.chipIndex, 10);
            managedFiles.splice(idx, 1);
            updateEntryPicker();
            renderChips(containerId, managedFiles);
            renderChips('folder-chips', []);
          });
        });
      }

      function syncManagedFiles() {
        managedFiles = [];
        var seen = new Set();
        var addFn = function(f) {
          var path = f.webkitRelativePath || f.name;
          if (!seen.has(path)) { seen.add(path); managedFiles.push({ file: f, path: path }); }
        };
        Array.from(filesInput.files || []).forEach(addFn);
        Array.from(folderInput.files || []).forEach(addFn);
        renderChips('upload-chips', managedFiles);
        renderChips('folder-chips', []);
      }

      function parseTags(value) {
        return value.split(',').map(function(t) { return t.trim(); }).filter(function(t) { return t.length > 0; });
      }

      function buildManifest() {
        const isListing = document.querySelector('input[name="page-kind"]:checked').value === 'listing';
        const pwd = document.getElementById('password').value;
        const manifest = {
          slug: document.getElementById('slug').value || undefined,
          title: document.getElementById('title').value || undefined,
          visibility: form.querySelector('input[name="visibility"]:checked').value,
          password: pwd || undefined,
        };
        if (isListing) {
          manifest.kind = 'listing';
          manifest.matchTags = document.getElementById('listing-match-tags').value || undefined;
        } else {
          manifest.showSource = document.getElementById('show_source').checked;
          manifest.entry = entryField.classList.contains('hidden') ? undefined : entrySelect.value;
          const tags = parseTags(document.getElementById('tags').value);
          if (tags.length > 0) manifest.tags = tags;
        }
        return JSON.stringify(manifest);
      }

      function updateEntryPicker() {
        const files = selectedFiles();
        const docs = files.filter(f => isDocument(f.path)).map(f => f.path);
        const images = files.filter(f => isImage(f.path)).map(f => f.path);
        const all = docs.length + images.length;
        if (docs.length === 1 && files.length === 1) {
          entryField.classList.add('hidden');
          entrySelect.innerHTML = '';
          return;
        }
        if (all === 1) {
          entryField.classList.add('hidden');
          entrySelect.innerHTML = '';
          return;
        }
        entryField.classList.remove('hidden');
        entrySelect.innerHTML = docs.concat(images).map(p => \`<option value="\${p}">\${p}</option>\`).join('');
        if (entrySelect.value === '' && docs.length > 0) {
          entrySelect.value = docs[0];
        }
      }

      filesInput.addEventListener('change', function() { syncManagedFiles(); updateEntryPicker(); });
      folderInput.addEventListener('change', function() { syncManagedFiles(); updateEntryPicker(); });

      // Page kind toggle: show/hide listing vs regular fields
      function togglePageKind() {
        var isListing = document.querySelector('input[name="page-kind"]:checked').value === 'listing';
        document.getElementById('listing-page-fields').classList.toggle('hidden', !isListing);
        document.getElementById('regular-page-fields').classList.toggle('hidden', isListing);
        document.getElementById('entry-field').classList.toggle('hidden', isListing);
      }
      document.querySelectorAll('input[name="page-kind"]').forEach(function(el) {
        el.addEventListener('change', togglePageKind);
      });

      // Paste kind toggle
      function togglePasteKind() {
        var isListing = document.querySelector('input[name="paste-page-kind"]:checked').value === 'listing';
        document.getElementById('paste-listing-fields').classList.toggle('hidden', !isListing);
        document.getElementById('paste-regular-fields').classList.toggle('hidden', isListing);
      }
      document.querySelectorAll('input[name="paste-page-kind"]').forEach(function(el) {
        el.addEventListener('change', togglePasteKind);
      });

      // Wire up dropzone drag/drop
      function initDropzone(dropzoneId, inputId) {
        var dz = document.getElementById(dropzoneId);
        var input = document.getElementById(inputId);
        if (!dz || !input) return;
        dz.addEventListener('dragover', function(e) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          dz.classList.add('drag-active');
        });
        dz.addEventListener('dragleave', function(e) {
          e.preventDefault();
          dz.classList.remove('drag-active');
        });
        dz.addEventListener('drop', function(e) {
          e.preventDefault();
          dz.classList.remove('drag-active');
          if (e.dataTransfer.files.length > 0) {
            var dt = new DataTransfer();
            for (var i = 0; i < e.dataTransfer.files.length; i++) {
              dt.items.add(e.dataTransfer.files[i]);
            }
            input.files = dt.files;
            syncManagedFiles();
            updateEntryPicker();
          }
        });
      }

      // Folder toggle
      var folderToggleEl = document.getElementById('folder-toggle');
      var folderWrapper = document.getElementById('folder-dropzone-wrapper');
      if (folderToggleEl && folderWrapper) {
        folderToggleEl.addEventListener('click', function() {
          var isVisible = folderWrapper.classList.toggle('visible');
          folderToggleEl.textContent = isVisible ? 'Hide folder upload' : 'Uploading a folder instead?';
        });
      }

      initDropzone('files-dropzone', 'files');
      initDropzone('folder-dropzone', 'folder');

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorBox.classList.remove('visible');
        errorBox.textContent = '';
        const files = selectedFiles();
        const pasted = pasteContent.value.trim();
        const isListingKind = document.querySelector('input[name="page-kind"]:checked').value === 'listing';
        if (!isListingKind && files.length === 0 && pasted === '') {
          errorBox.textContent = 'Provide either files or paste content.';
          errorBox.classList.add('visible');
          return;
        }
        if (!isListingKind && files.length > 0 && pasted !== '') {
          errorBox.textContent = 'Provide either files or paste content, not both.';
          errorBox.classList.add('visible');
          return;
        }
        const formData = new FormData();
        managedFiles.forEach(function(item) {
          formData.append('file:' + item.path, item.file, item.path);
        });
        formData.append('manifest', buildManifest());
        const res = await fetch('/api/pages', { method: 'POST', body: formData });
        if (res.ok) {
          window.location.href = '/admin';
        } else {
          const body = await res.json().catch(() => ({ error: 'Upload failed' }));
          errorBox.textContent = body.message || body.error || 'Upload failed';
          errorBox.classList.add('visible');
        }
      });

      pasteForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        errorBox.classList.remove('visible');
        errorBox.textContent = '';
        const files = selectedFiles();
        const isPasteListing = pasteForm.querySelector('input[name="paste-page-kind"]:checked').value === 'listing';
        if (!isPasteListing && files.length === 0 && pasteContent.value.trim() === '') {
          errorBox.textContent = 'Provide either files or paste content.';
          errorBox.classList.add('visible');
          return;
        }
        if (!isPasteListing && files.length > 0 && pasteContent.value.trim() !== '') {
          errorBox.textContent = 'Provide either files or paste content, not both.';
          errorBox.classList.add('visible');
          return;
        }
        const isPasteListing = pasteForm.querySelector('input[name="paste-page-kind"]:checked').value === 'listing';
        var pastePwd = document.getElementById('paste-password').value;
        const payload = {
          slug: document.getElementById('paste-slug').value || undefined,
          title: document.getElementById('paste-title').value || undefined,
          visibility: pasteForm.querySelector('input[name="paste-visibility"]:checked').value,
          password: pastePwd || undefined,
        };
        if (isPasteListing) {
          payload.kind = 'listing';
          payload.matchTags = document.getElementById('paste-match-tags').value || undefined;
        } else {
          const pasteFormat = pasteForm.querySelector('input[name="paste-format"]:checked').value;
          var pasteTags = parseTags(document.getElementById('paste-tags').value);
          payload.content = pasteContent.value;
          payload.format = pasteFormat;
          payload.showSource = document.getElementById('paste-show-source').checked;
          if (pasteTags.length > 0) payload.tags = pasteTags;
        }
        const res = await fetch('/api/pages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          window.location.href = '/admin';
        } else {
          const body = await res.json().catch(() => ({ error: 'Publish failed' }));
          errorBox.textContent = body.message || body.error || 'Publish failed';
          errorBox.classList.add('visible');
        }
      });
    })();
  </script>`;
}

export async function handleAdminUpload(
  _request: Request,
  _ctx: ExecutionContext,
  deps: AdminUiDeps,
): Promise<Response> {
  const { cacheService, config, verifiedIdentity } = deps;
  const content = uploadContent();
  const body = layout(config, verifiedIdentity, content);
  return htmlResponse(cacheService, body);
}

async function loadPageDetail(
  deps: AdminUiDeps,
  id: string,
): Promise<{ page: PageRecord; files: FileRecord[] } | null> {
  if (!validateId(id)) return null;
  const page = await deps.pagesRepository.getById(id);
  if (!page) return null;
  const files = await deps.filesRepository.listForPage(id);
  return { page, files };
}

function fileKindIcon(filename: string): string {
  const lower = filename.toLowerCase();
  let icon: string;
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    icon = "file-html";
  } else if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
    icon = "file-markdown";
  } else if (/\.(png|jpg|jpeg|gif|webp|svg|avif)$/.test(lower)) {
    icon = "file-image";
  } else {
    icon = "file";
  }
  return `<svg class="icon" width="20" height="20" aria-hidden="true"><use href="#icon-${icon}"></use></svg>`;
}

function pageKindIcon(kind: string): string {
  const kindIconMap: Record<string, string> = {
    html: "file-html",
    markdown: "file-markdown",
    image: "file-image",
    bundle: "file-bundle",
  };
  const icon = kindIconMap[kind] ?? "file";
  return `<svg class="icon" width="16" height="16" aria-hidden="true"><use href="#icon-${icon}"></use></svg>`;
}

function editContent(
  page: PageRecord,
  files: FileRecord[],
  tags: string[],
  requestUrl: URL,
): string {
  const backUrl = new URL("/admin", requestUrl).pathname;
  const pageApiUrl = `/api/pages/${page.id}`;
  const filesApiUrl = `/api/pages/${page.id}/files`;
  const protectedHint =
    files.length > 0
      ? '<p class="file-hint">Rendered page files are protected — use Delete page above to remove the page.</p>'
      : "";

  const fileRows = files
    .map((file) => {
      const deleteUrl = `/api/pages/${page.id}/files/${encodeURIComponent(file.path)}`;
      const isProtected = isProtectedEntryPath(page, file.path);
      const deleteButton = isProtected
        ? ""
        : `<button class="button button-danger button-small" type="button" data-delete-file="${escapeHtml(deleteUrl)}">Delete</button>`;
      const kindSvg = fileKindIcon(file.path);
      const protectedBadge = isProtected
        ? `<span class="badge protected"><svg class="icon" width="14" height="14" aria-hidden="true"><use href="#icon-lock"></use></svg>Protected</span>`
        : "";
      return `<li class="file-row">
        <div class="file-meta">
          ${kindSvg}<code class="file-path">${escapeHtml(file.path)}</code>
          ${protectedBadge}
        </div>
        ${deleteButton}
      </li>`;
    })
    .join("\n");

  const slugValue = escapeHtml(page.slug ?? "");
  const titleValue = escapeHtml(page.title ?? "");
  const publicChecked = page.visibility === "public" ? "checked" : "";
  const unlistedChecked = page.visibility === "unlisted" ? "checked" : "";
  const showSourceChecked = page.show_source === 1 ? "checked" : "";
  const kindSvg = pageKindIcon(page.kind);
  const tagsValue = escapeHtml(tags.join(", "));
  const matchTagsValue = escapeHtml(page.match_tags ?? "");
  const isListing = page.kind === "listing";
  const listingMatchField = isListing
    ? `<div class="form-group">
        <label class="field-label" for="edit-match-tags">Match tags <span class="hint">Show all public pages that match ANY of these tags (comma-separated)</span></label>
        <input type="text" name="matchTags" id="edit-match-tags" value="${matchTagsValue}" placeholder="blog, tech">
      </div>`
    : "";

  return `<div class="page-nav">
    <a href="${escapeHtml(backUrl)}"><svg class="icon" width="20" height="20" aria-hidden="true"><use href="#icon-arrow-left"></use></svg>Back</a>
  </div>
  <div class="card">
    <header>
      <h2>Edit ${escapeHtml(page.title)} <span class="badge kind-${escapeHtml(page.kind)}">${kindSvg}${escapeHtml(page.kind)}</span> <span class="badge visibility-${escapeHtml(page.visibility)}">${escapeHtml(page.visibility)}</span></h2>
      <button class="button button-danger" type="button" id="delete-page" data-delete="${escapeHtml(pageApiUrl)}">Delete page</button>
    </header>
    <form id="edit-form" data-api="${escapeHtml(pageApiUrl)}">
      <div class="error-box" id="edit-error" role="alert"></div>
      <div class="form-group">
        <label class="field-label" for="edit-slug">Slug</label>
        <input type="text" name="slug" id="edit-slug" value="${slugValue}" placeholder="my-page">
        <span class="slug-preview" id="edit-slug-preview"></span>
      </div>
      <div class="form-group">
        <label class="field-label" for="title">Title</label>
        <input type="text" name="title" id="title" value="${titleValue}">
      </div>
      <div class="form-group">
        <span class="field-label">Visibility</span>
        <div class="radio-group">
          <label><input type="radio" name="visibility" value="public" ${publicChecked}> Public</label>
          <label><input type="radio" name="visibility" value="unlisted" ${unlistedChecked}> Unlisted</label>
        </div>
      </div>
      <div class="form-group">
        <label class="checkbox-label">
          <input type="checkbox" name="showSource" value="true" ${showSourceChecked}>
          Show source link
        </label>
      </div>
      <div class="form-group">
        <label class="field-label" for="edit-tags">Tags <span class="hint">(optional, comma-separated)</span></label>
        <input type="text" name="tags" id="edit-tags" value="${tagsValue}" placeholder="blog, tech, announcement">
      </div>
      ${listingMatchField}
      <fieldset class="form-group">
        <legend class="field-label">Password</legend>
        ${
          page.password_hash !== null
            ? `<p><strong>Password:</strong> set</p>
             <p id="edit-password-notice">All access will bypass the CDN which may increase usage.</p>`
            : ""
        }
        <label class="field-label" for="edit-password">Replace password <span class="hint">(optional; leave blank to keep current)</span></label>
        <input type="password" name="password" id="edit-password" minlength="5" placeholder="New password">
        ${
          page.password_hash !== null
            ? `<div class="form-group">
              <label class="checkbox-label">
                <input type="checkbox" name="clear-password" id="clear-password" value="true">
                Clear password
              </label>
            </div>`
            : ""
        }
      </fieldset>
      <div class="toolbar">
        <button type="submit" class="button button-primary">Update metadata</button>
      </div>
    </form>
  </div>

  <div class="card">
    <header>
      <h3>Files</h3>
    </header>
    ${protectedHint}
    ${files.length === 0 ? '<p class="file-hint">No files.</p>' : `<ul class="file-list">${fileRows}</ul>`}
  </div>

  <div class="card">
    <header>
      <h3>Add / replace files</h3>
    </header>
    <form id="add-files-form" data-api="${escapeHtml(filesApiUrl)}">
      <div class="error-box" id="add-files-error" role="alert"></div>
      <div class="form-group">
        <label class="field-label" for="add-files">Files</label>
        <input type="file" name="files" id="add-files" multiple>
        <span class="hint">Choose one or more loose files.</span>
      </div>
      <div class="form-group">
        <label class="field-label" for="add-folder">Folder upload</label>
        <input type="file" name="folder" id="add-folder" multiple webkitdirectory>
        <span class="hint">Preserves relative paths inside the selected folder.</span>
      </div>
      <div class="toolbar">
        <button type="submit" class="button button-primary">Upload files</button>
      </div>
    </form>
  </div>

  <script>
    (function() {
      initSlugPreview('edit-slug', 'edit-slug-preview');

      const editForm = document.getElementById('edit-form');
      const editError = document.getElementById('edit-error');
      editForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        editError.classList.remove('visible');
        const formData = new FormData(editForm);
        const body = {};
        const slug = formData.get('slug');
        if (slug !== '') body.slug = slug;
        const title = formData.get('title');
        if (title !== '') body.title = title;
        body.visibility = formData.get('visibility');
        body.showSource = formData.has('showSource');
        var tagsVal = document.getElementById('edit-tags').value;
        if (tagsVal) {
          body.tags = parseTags(tagsVal);
        } else {
          body.tags = [];
        }
        var matchTagsEl = document.getElementById('edit-match-tags');
        if (matchTagsEl) {
          body.matchTags = matchTagsEl.value || '';
        }
        const pwd = formData.get('password');
        if (pwd && pwd !== '') {
          body.password = pwd;
        }${
          page.password_hash !== null
            ? `
        var clearEl = document.getElementById('clear-password');
        if (clearEl && clearEl.checked) {
          body.password = '';
        }`
            : ""
        }
        const res = await fetch(editForm.dataset.api, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          window.location.reload();
        } else {
          const data = await res.json().catch(() => ({ error: 'Update failed' }));
          editError.textContent = data.message || data.error || 'Update failed';
          editError.classList.add('visible');
        }
      });

      document.querySelectorAll('[data-delete-file]').forEach(function(btn) {
        btn.addEventListener('click', async function() {
          if (!confirm('Delete this file?')) return;
          const res = await fetch(btn.dataset.deleteFile, { method: 'DELETE' });
          if (res.ok) {
            window.location.reload();
          } else {
            const data = await res.json().catch(function() { return { error: 'Delete failed' }; });
            showToast(data.message || data.error || 'Delete failed', 'error');
          }
        });
      });

      const addFilesForm = document.getElementById('add-files-form');
      const addFilesError = document.getElementById('add-files-error');
      const addFilesInput = document.getElementById('add-files');
      const addFolderInput = document.getElementById('add-folder');
      addFilesForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        addFilesError.classList.remove('visible');
        const files = Array.from(addFilesInput.files || []).concat(Array.from(addFolderInput.files || []));
        if (files.length === 0) {
          addFilesError.textContent = 'Choose at least one file or folder.';
          addFilesError.classList.add('visible');
          return;
        }
        const formData = new FormData();
        const relative = f => f.webkitRelativePath || f.name;
        files.forEach(f => formData.append('file:' + relative(f), f, relative(f)));
        const res = await fetch(addFilesForm.dataset.api, { method: 'POST', body: formData });
        if (res.ok) {
          window.location.reload();
        } else {
          const data = await res.json().catch(() => ({ error: 'Upload failed' }));
          addFilesError.textContent = data.message || data.error || 'Upload failed';
          addFilesError.classList.add('visible');
        }
      });

      document.getElementById('delete-page').addEventListener('click', async function() {
        if (!confirm('Delete this page and all its files? This cannot be undone.')) return;
        const deletePage = document.getElementById('delete-page');
        const res = await fetch(deletePage.dataset.delete, { method: 'DELETE' });
        if (res.ok) {
          window.location.href = '${escapeHtml(backUrl)}';
        } else {
          const data = await res.json().catch(function() { return { error: 'Delete failed' }; });
          showToast(data.message || data.error || 'Delete failed', 'error');
        }
      });
    })();
  </script>`;
}

export async function handleAdminEdit(
  request: Request,
  _ctx: ExecutionContext,
  deps: AdminUiDeps,
): Promise<Response> {
  const { cacheService, config, verifiedIdentity } = deps;
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/admin\/edit\/([^/]+)\/?$/);
  const id = match ? match[1] : undefined;
  if (!id || !validateId(id)) {
    throw new AppError("invalid_id", 400, "Invalid page id.");
  }
  const detail = await loadPageDetail(deps, id);
  if (!detail) {
    throw new AppError("not_found", 404, "Page not found.");
  }
  const pageTags = deps.tagsRepository ? await deps.tagsRepository.getByPageId(id) : [];
  const content = editContent(detail.page, detail.files, pageTags, url);
  const body = layout(config, verifiedIdentity, content);
  return htmlResponse(cacheService, body);
}

function settingsContent(settings: Record<string, string>): string {
  const defaultPage = settings.default_page ?? "";
  return `<div class="page-nav">
    <a href="/admin"><svg class="icon" width="20" height="20" aria-hidden="true"><use href="#icon-arrow-left"></use></svg>Dashboard</a>
  </div>
  <div class="card">
    <header>
      <h2>Settings</h2>
    </header>
    <form id="settings-form">
      <div class="error-box" id="settings-error" role="alert"></div>
      <div class="form-group">
        <label class="field-label" for="settings-default-page">Default page <span class="hint">The page slug to serve at the root URL (e.g. "my-home-page"). Leave empty to use the configured HOME_MODE.</span></label>
        <input type="text" name="default_page" id="settings-default-page" value="${escapeHtml(defaultPage)}" placeholder="my-home-page">
        <span class="slug-preview" id="settings-slug-preview"></span>
      </div>
      <div class="toolbar">
        <button type="submit" class="button button-primary">Save settings</button>
      </div>
    </form>
  </div>
  <script>
    (function() {
      initSlugPreview('settings-default-page', 'settings-slug-preview');
      var form = document.getElementById('settings-form');
      var errorBox = document.getElementById('settings-error');
      form.addEventListener('submit', async function(e) {
        e.preventDefault();
        errorBox.classList.remove('visible');
        var defaultPage = document.getElementById('settings-default-page').value.trim();
        var body = {};
        if (defaultPage) {
          body.default_page = defaultPage;
        } else {
          body.default_page = '';
        }
        var res = await fetch('/api/settings', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          showToast('Settings saved.', 'success');
        } else {
          var data = await res.json().catch(function() { return { error: 'Save failed' }; });
          errorBox.textContent = data.message || data.error || 'Save failed';
          errorBox.classList.add('visible');
        }
      });
    })();
  </script>`;
}

export async function handleAdminSettings(
  _request: Request,
  _ctx: ExecutionContext,
  deps: AdminUiDeps,
): Promise<Response> {
  const { cacheService, config, verifiedIdentity, settingsRepository } = deps;
  const settings = await settingsRepository!.getAll();
  const content = settingsContent(settings);
  const body = layout(config, verifiedIdentity, content);
  return htmlResponse(cacheService, body);
}
