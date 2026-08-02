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
import type { AppConfig } from "./config";
import type { CacheService } from "./cache-service";
import type { PagesRepository, PageRecord } from "./pages-repository";
import type { FilesRepository, FileRecord } from "./files-repository";
import type { ObjectStore } from "./object-store";
import type { VerifiedIdentity } from "./access-verify";

export interface AdminUiDeps {
  config: AppConfig;
  cacheService: CacheService;
  pagesRepository: PagesRepository;
  filesRepository: FilesRepository;
  objectStore: ObjectStore;
  verifiedIdentity: VerifiedIdentity;
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

function layout(config: AppConfig, verifiedIdentity: VerifiedIdentity, content: string): string {
  const email = escapeHtml(verifiedIdentity.email ?? "unknown");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(pageTitle(config))}</title>
  <style>
    :root { --bg: #f8f9fa; --panel: #fff; --text: #212529; --muted: #6c757d; --accent: #0d6efd; --danger: #dc3545; --border: #dee2e6; }
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 0; background: var(--bg); color: var(--text); line-height: 1.5; }
    header { background: var(--panel); border-bottom: 1px solid var(--border); padding: 1rem 1.5rem; display: flex; align-items: center; justify-content: space-between; }
    header h1 { margin: 0; font-size: 1.25rem; }
    header .identity { color: var(--muted); font-size: 0.875rem; }
    main { max-width: 960px; margin: 2rem auto; padding: 0 1.5rem; }
    .card { background: var(--panel); border: 1px solid var(--border); border-radius: 0.5rem; padding: 1.5rem; margin-bottom: 1.5rem; }
    h2 { margin-top: 0; }
    .toolbar { display: flex; gap: 1rem; margin-bottom: 1rem; flex-wrap: wrap; }
    button, .button { display: inline-flex; align-items: center; justify-content: center; padding: 0.5rem 1rem; border-radius: 0.375rem; border: 1px solid var(--accent); background: var(--accent); color: #fff; text-decoration: none; font-size: 0.9375rem; cursor: pointer; }
    .button.secondary { background: var(--panel); color: var(--accent); }
    .button.danger { background: var(--danger); border-color: var(--danger); }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 0.75rem; border-bottom: 1px solid var(--border); }
    th { font-weight: 600; color: var(--muted); font-size: 0.875rem; }
    .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    .actions a { font-size: 0.875rem; }
    .empty { color: var(--muted); text-align: center; padding: 2rem; }
    .empty .button { margin-top: 1rem; }
    form { display: flex; flex-direction: column; gap: 1rem; }
    label { display: flex; flex-direction: column; gap: 0.25rem; font-weight: 500; }
    input[type="text"], input[type="file"], select, textarea { padding: 0.5rem; border: 1px solid var(--border); border-radius: 0.375rem; font-size: 0.9375rem; }
    .hint { color: var(--muted); font-size: 0.875rem; font-weight: 400; }
    .radio-group { display: flex; gap: 1rem; align-items: center; }
    .radio-group label { flex-direction: row; align-items: center; font-weight: 400; }
    .error { color: var(--danger); background: #fff5f5; border: 1px solid #f5c6cb; padding: 0.75rem; border-radius: 0.375rem; display: none; }
    .file-list { list-style: none; padding: 0; margin: 0; }
    .file-list li { display: flex; align-items: center; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid var(--border); }
    .hidden { display: none; }
    .inline { display: inline; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(config.siteName)}</h1>
    <span class="identity">${email}</span>
  </header>
  <main>
    ${content}
  </main>
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
      return `<tr>
        <td>${escapeHtml(page.title)}</td>
        <td>${escapeHtml(page.slug ?? "—")}</td>
        <td><code>${escapeHtml(page.id)}</code></td>
        <td>${escapeHtml(page.kind)}</td>
        <td>${escapeHtml(page.created_at)}</td>
        <td>${escapeHtml(page.visibility)}</td>
        <td>
          <div class="actions">
            <a class="button secondary" href="${escapeHtml(viewUrl)}">View</a>
            <a class="button secondary" href="${escapeHtml(editUrl)}">Edit</a>
            <button class="button danger" type="button" data-delete="${escapeHtml(deleteUrl)}">Delete</button>
          </div>
        </td>
      </tr>`;
    })
    .join("\n");

  const table =
    pages.length === 0
      ? `<div class="card empty">
        <p>No pages yet.</p>
        <a class="button" href="${escapeHtml(uploadUrl)}">Upload your first page</a>
      </div>`
      : `<table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Slug</th>
            <th>ID</th>
            <th>Kind</th>
            <th>Created</th>
            <th>Visibility</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;

  return `<div class="card">
    <div class="toolbar">
      <h2 class="inline">Pages</h2>
      <a class="button" href="${escapeHtml(uploadUrl)}">Upload</a>
    </div>
    ${table}
  </div>
  <script>
    document.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this page and all its files? This cannot be undone.')) return;
        const res = await fetch(btn.dataset.delete, { method: 'DELETE' });
        if (res.ok) {
          window.location.reload();
        } else {
          const body = await res.json().catch(() => ({ error: 'Delete failed' }));
          alert(body.error || 'Delete failed');
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
  return `<div class="card">
    <h2>Upload a page</h2>
    <p class="hint">Choose one or more files, or upload a folder to preserve its relative paths.</p>
    <!-- Multipart convention: manifest JSON field + file:<path> file parts -->
    <form id="upload-form" action="/api/pages" method="POST" enctype="multipart/form-data">
      <div class="error" id="upload-error" role="alert"></div>
      <!-- Two pickers: webkitdirectory on the same input as multiple forces
           directory-only selection, so loose files live on #files (multiple-only)
           and folder upload (relative paths, spec §10) is a separate opt-in input.
           The JS unifies both via webkitRelativePath || name. -->
      <label>
        Files
        <input type="file" name="files" id="files" multiple>
      </label>
      <label>
        or upload a folder (preserves relative paths)
        <input type="file" name="folder" id="folder" multiple webkitdirectory>
      </label>
      <label>
        Slug <span class="hint">(optional)</span>
        <input type="text" name="slug" id="slug" placeholder="my-page">
      </label>
      <label>
        Title <span class="hint">(optional; defaults to filename)</span>
        <input type="text" name="title" id="title" placeholder="My Page">
      </label>
      <label>
        Visibility
        <div class="radio-group">
          <label><input type="radio" name="visibility" value="public" checked> Public</label>
          <label><input type="radio" name="visibility" value="unlisted"> Unlisted</label>
        </div>
      </label>
      <label>
        <input type="checkbox" name="show_source" id="show_source" value="true">
        Show source link (for Markdown pages)
      </label>
      <div id="entry-field" class="hidden">
        <label>
          Entry file
          <select name="entry" id="entry"></select>
          <span class="hint">Which file is the page entry?</span>
        </label>
      </div>
      <input type="hidden" name="manifest" id="manifest">
      <div class="toolbar">
        <button type="submit">Upload</button>
        <a class="button secondary" href="/admin">Cancel</a>
      </div>
    </form>
  </div>
  <script>
    const form = document.getElementById('upload-form');
    const filesInput = document.getElementById('files');
    const folderInput = document.getElementById('folder');
    const manifestInput = document.getElementById('manifest');
    const entryField = document.getElementById('entry-field');
    const entrySelect = document.getElementById('entry');
    const errorBox = document.getElementById('upload-error');
    const documentExts = ['.html', '.htm', '.md', '.markdown'];

    function selectedFiles() {
      return Array.from(filesInput.files || []).concat(Array.from(folderInput.files || []));
    }

    function isDocument(name) {
      const lower = name.toLowerCase();
      return documentExts.some(ext => lower.endsWith(ext));
    }

    function isImage(name) {
      const lower = name.toLowerCase();
      return /\\.(png|jpg|jpeg|gif|webp|svg|avif)$/.test(lower);
    }

    function buildManifest() {
      const files = selectedFiles();
      const relative = f => f.webkitRelativePath || f.name;
      const manifest = {
        slug: document.getElementById('slug').value || undefined,
        title: document.getElementById('title').value || undefined,
        showSource: document.getElementById('show_source').checked,
        visibility: form.querySelector('input[name="visibility"]:checked').value,
        entry: entryField.classList.contains('hidden') ? undefined : entrySelect.value,
      };
      return JSON.stringify(manifest);
    }

    function updateEntryPicker() {
      const files = selectedFiles();
      const relative = f => f.webkitRelativePath || f.name;
      const docs = files.filter(f => isDocument(relative(f))).map(relative);
      const images = files.filter(f => isImage(relative(f))).map(relative);
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

    filesInput.addEventListener('change', updateEntryPicker);
    folderInput.addEventListener('change', updateEntryPicker);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorBox.style.display = 'none';
      errorBox.textContent = '';
      const files = selectedFiles();
      if (files.length === 0) {
        errorBox.textContent = 'Choose at least one file or folder.';
        errorBox.style.display = 'block';
        return;
      }
      const formData = new FormData();
      const relative = f => f.webkitRelativePath || f.name;
      files.forEach(f => formData.append('file:' + relative(f), f, relative(f)));
      formData.append('manifest', buildManifest());
      const res = await fetch('/api/pages', { method: 'POST', body: formData });
      if (res.ok) {
        window.location.href = '/admin';
      } else {
        const body = await res.json().catch(() => ({ error: 'Upload failed' }));
        errorBox.textContent = body.error || 'Upload failed';
        errorBox.style.display = 'block';
      }
    });
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

function editContent(page: PageRecord, files: FileRecord[], requestUrl: URL): string {
  const backUrl = new URL("/admin", requestUrl).pathname;
  const pageApiUrl = `/api/pages/${page.id}`;
  const filesApiUrl = `/api/pages/${page.id}/files`;
  const fileRows = files
    .map((file) => {
      const deleteUrl = `/api/pages/${page.id}/files/${encodeURIComponent(file.path)}`;
      return `<li>
        <code>${escapeHtml(file.path)}</code>
        <button class="button danger" type="button" data-delete-file="${escapeHtml(deleteUrl)}">Delete</button>
      </li>`;
    })
    .join("\n");

  const slugValue = escapeHtml(page.slug ?? "");
  const titleValue = escapeHtml(page.title ?? "");
  const publicChecked = page.visibility === "public" ? "checked" : "";
  const unlistedChecked = page.visibility === "unlisted" ? "checked" : "";
  const showSourceChecked = page.show_source === 1 ? "checked" : "";

  return `<div class="card">
    <div class="toolbar">
      <h2 class="inline">Edit ${escapeHtml(page.title)}</h2>
      <button class="button danger" type="button" id="delete-page" data-delete="${escapeHtml(pageApiUrl)}">Delete page</button>
    </div>
    <form id="edit-form" data-api="${escapeHtml(pageApiUrl)}">
      <div class="error" id="edit-error" role="alert"></div>
      <label>
        Slug
        <input type="text" name="slug" value="${slugValue}" placeholder="my-page">
      </label>
      <label>
        Title
        <input type="text" name="title" value="${titleValue}">
      </label>
      <label>
        Visibility
        <div class="radio-group">
          <label><input type="radio" name="visibility" value="public" ${publicChecked}> Public</label>
          <label><input type="radio" name="visibility" value="unlisted" ${unlistedChecked}> Unlisted</label>
        </div>
      </label>
      <label>
        <input type="checkbox" name="showSource" value="true" ${showSourceChecked}>
        Show source link
      </label>
      <div class="toolbar">
        <button type="submit">Update metadata</button>
        <a class="button secondary" href="${escapeHtml(backUrl)}">Back</a>
      </div>
    </form>
  </div>

  <div class="card">
    <h3>Files</h3>
    ${files.length === 0 ? '<p class="hint">No files.</p>' : `<ul class="file-list">${fileRows}</ul>`}
    <h4>Add / replace files</h4>
    <form id="add-files-form" data-api="${escapeHtml(filesApiUrl)}">
      <div class="error" id="add-files-error" role="alert"></div>
      <!-- Two pickers: #add-files is multiple-only (webkitdirectory on the same
           input as multiple forces directory-only selection); folder upload is a
           separate opt-in webkitdirectory input. The JS unifies both via
           webkitRelativePath || name. -->
      <label>
        Files
        <input type="file" name="files" id="add-files" multiple>
      </label>
      <label>
        or a folder
        <input type="file" name="folder" id="add-folder" multiple webkitdirectory>
      </label>
      <button type="submit">Upload files</button>
    </form>
  </div>

  <script>
    const editForm = document.getElementById('edit-form');
    const editError = document.getElementById('edit-error');
    editForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      editError.style.display = 'none';
      const formData = new FormData(editForm);
      const body = {};
      const slug = formData.get('slug');
      if (slug !== '') body.slug = slug;
      const title = formData.get('title');
      if (title !== '') body.title = title;
      body.visibility = formData.get('visibility');
      body.showSource = formData.has('showSource');
      const res = await fetch(editForm.dataset.api, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        window.location.reload();
      } else {
        const data = await res.json().catch(() => ({ error: 'Update failed' }));
        editError.textContent = data.error || 'Update failed';
        editError.style.display = 'block';
      }
    });

    document.querySelectorAll('[data-delete-file]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this file?')) return;
        const res = await fetch(btn.dataset.deleteFile, { method: 'DELETE' });
        if (res.ok) {
          window.location.reload();
        } else {
          const data = await res.json().catch(() => ({ error: 'Delete failed' }));
          alert(data.error || 'Delete failed');
        }
      });
    });

    const addFilesForm = document.getElementById('add-files-form');
    const addFilesError = document.getElementById('add-files-error');
    const addFilesInput = document.getElementById('add-files');
    const addFolderInput = document.getElementById('add-folder');
    addFilesForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      addFilesError.style.display = 'none';
      const files = Array.from(addFilesInput.files || []).concat(Array.from(addFolderInput.files || []));
      if (files.length === 0) {
        addFilesError.textContent = 'Choose at least one file or folder.';
        addFilesError.style.display = 'block';
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
        addFilesError.textContent = data.error || 'Upload failed';
        addFilesError.style.display = 'block';
      }
    });

    document.getElementById('delete-page').addEventListener('click', async () => {
      if (!confirm('Delete this page and all its files? This cannot be undone.')) return;
      const res = await fetch(document.getElementById('delete-page').dataset.delete, { method: 'DELETE' });
      if (res.ok) {
        window.location.href = '${escapeHtml(backUrl)}';
      } else {
        const data = await res.json().catch(() => ({ error: 'Delete failed' }));
        alert(data.error || 'Delete failed');
      }
    });
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
  const content = editContent(detail.page, detail.files, url);
  const body = layout(config, verifiedIdentity, content);
  return htmlResponse(cacheService, body);
}
