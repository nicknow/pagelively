# User guide

This is the guide for actually _using_ Pagelively once it's deployed — signing in, publishing
pages, and managing them day to day. If you haven't deployed it yet, start with the
[README quickstart](../../README.md) or the full [operations guide](../operations/README.md).

If you're looking for developer-facing docs (how the software is built, the API contracts,
architecture decisions), see the [documentation index](../README.md) instead.

## Contents

- [The mental model](#the-mental-model)
- [Signing in](#signing-in)
- [The dashboard](#the-dashboard)
- [Publishing your first page](#publishing-your-first-page)
- [ids, slugs, and URLs](#ids-slugs-and-urls)
- [Editing a page](#editing-a-page)
- [Adding, replacing, and deleting files](#adding-replacing-and-deleting-files)
- [Deleting a page](#deleting-a-page)
- [Markdown specifics](#markdown-specifics)
- [Understanding errors](#understanding-errors)
- [FAQ](#faq)

## The mental model

Everything you publish is a **Page**. A Page has:

- An **id** — short, auto-generated, permanent. `/p/{id}/` always works.
- An optional **slug** — a friendly name you choose (or one generated from your title/filename).
  `/{slug}/` is a nicer alias for the same page. You can change the slug later without losing
  anything.
- A **kind** — `image`, `html`, `markdown`, or `bundle` (a document plus its supporting files),
  detected automatically from what you upload.
- One or more **files**. Every page has one **entry file** — the thing people see when they
  visit the page's URL.

Uploading a page and _replacing its files later_ never breaks the URL: the id and slug you
publish under stay the same for as long as the page exists.

## Signing in

The admin area lives at `https://your-domain/admin`. It's protected by **Cloudflare Access**,
not an in-app login — visiting `/admin` for the first time shows Cloudflare's own sign-in
screen (email one-time-code by default, unless you configured a different identity provider
during setup). Only the email address(es) you allowed during setup can get in.

Once signed in, your verified email address is shown in the top-right of every admin page. To
sign out, visit `https://your-domain/cdn-cgi/access/logout` — this is Cloudflare Access's own
logout endpoint, not something the app implements itself.

Public pages (anything under `/{slug}/` or `/p/{id}/`) are never behind this login — only
`/admin*` and `/api/*` are protected.

## The dashboard

`/admin` lists every page you've published: title, kind badge, visibility badge, and creation
date, with **View**, **Edit**, and **Delete** actions on each row. **View** opens the live
public page; **Edit** takes you to that page's edit screen (below). If you have no pages yet,
the dashboard shows an **Upload your first page** button instead of an empty table.

## Publishing your first page

Click **Upload** from the dashboard (`/admin/upload`). There are two ways to publish:

### Upload files

- **Files** — pick one or more loose files (images, an HTML file, a Markdown file, CSS, JS,
  whatever your page needs).
- **Folder upload** — pick an entire folder instead; relative paths inside it (e.g.
  `images/photo.png` referenced from your HTML) are preserved. Use _either_ the files picker or
  the folder picker for a given upload, not both — they exist as two separate controls because
  a browser folder picker can't also let you multi-select loose files.
- **Slug** (optional) — leave it blank to get one generated from your title/filename, or type
  your own; a live preview shows the resulting URL as you type.
- **Title** (optional) — defaults to the filename if you leave it blank.
- **Visibility** — `public` (default) or `unlisted` (see [FAQ](#faq)).
- **Show source** — for Markdown pages, adds a link to download the original `.md` file.
- **Entry file** — this picker only appears if what you selected is ambiguous (e.g. two HTML
  files, or an HTML file and an image with no other files). Pick which one is the actual page;
  everything else becomes a supporting asset. If you upload just one document (optionally with
  assets alongside it), or one image, Pagelively figures out the entry automatically and this
  picker stays hidden.

Click **Upload** to publish. On success you're taken back to the dashboard; on failure the
error appears inline above the form (see [Understanding errors](#understanding-errors)).

### Paste content

For quick notes or snippets, switch to the **Paste content** tab: paste HTML or Markdown
directly into the text box, choose the format (Markdown is the default), fill in the same
slug/title/visibility/show-source fields, and click **Publish**. This is the fastest path when
you don't have a file to upload — there's no file picker involved at all.

### Tags

Both the **Upload files** and **Paste content** forms have a **Tags** field. Tags are simple
labels you can add to a page — for example `blog`, `tech`, `announcement`. You can enter them
as a comma-separated list. Tags are normalized to lowercase automatically.

From the edit screen, you can change a page's tags at any time. Click **Update metadata** to
save the changes. Tags are included in the page's API response and can be used to organize
your content.

### Listing pages

A **listing page** is a special kind of page that automatically shows a list of links to
other pages. You create a listing page by selecting **Listing page** from the **Page kind**
selector on the upload or paste form, then entering the tags you want to match in the
**Match tags** field (comma-separated).

When someone visits a listing page's URL, Pagelively finds all **public** pages that have
**all** the tags you specified and renders them as a linked list, newest first. Pages
marked `unlisted` are excluded. A page that has _additional_ tags beyond the ones you
specified is still included — only the matching tags count.

> **Note: up to 5-minute delay.** Listing page output is cached by Cloudflare's edge network
> for up to 5 minutes. When you add or change tags on an individual page, any listing page
> that references those tags may not reflect the change for up to 5 minutes. This is normal
> — the listing page is a server-rendered view that gets cached like any other page, and
> changing a page's tags doesn't automatically flush the cached output of every listing page
> that might reference it. If you need to see an immediate update, wait for the cache to
> expire (up to 5 minutes) and refresh.

## ids, slugs, and URLs

Every page is reachable two ways:

- `https://your-domain/p/{id}/` — the permanent, canonical URL. Never changes.
- `https://your-domain/{slug}/` — the friendly URL, if the page has a slug.

A handful of names are reserved and can't be used as slugs, because they're already routes the
app uses: `p`, `api`, `admin`, `assets`, `favicon.ico`, `robots.txt`, `health`, `sitemap.xml`,
and anything starting with `_`. If you try one, you'll get an `invalid_slug` error — pick
something else.

Visiting a slug without the trailing slash (`/my-page`) automatically redirects to the correct
form (`/my-page/`).

## Editing a page

Click **Edit** on any dashboard row (`/admin/edit/{id}`) to get three sections:

- **Header** — shows the title, kind, and visibility, plus a **Delete page** button.
- **Metadata** — update slug, title, visibility, or the show-source toggle, then click
  **Update metadata**. Changing these never changes the page's URL history or breaks existing
  links to the id-based URL; changing the slug does change the slug-based URL.
- **Files** — see [below](#adding-replacing-and-deleting-files).

## Adding, replacing, and deleting files

From the edit screen's **Files** card, you'll see every file in the page. The file(s) that make
up the entry (`index.html`, `source.md` for Markdown pages, or the image itself for image
pages) are marked **Protected** and have no delete button — you can't remove the thing that
makes the page work without removing the whole page. Every other file has its own **Delete**
button (with a confirmation prompt).

The **Add / replace files** card at the bottom lets you upload more files or an entire folder
into the page — same file/folder pickers as publishing. Uploading a file with the same path as
an existing one replaces it; uploading the entry document itself (e.g. a new `index.html` or a
new `.md` file) re-publishes the page with that new content.

## Deleting a page

**Delete page** (on the edit screen) or **Delete** (on the dashboard row) removes the page
entirely — all its files and its database record. This is confirmed with a prompt and **cannot
be undone**. There's no trash or recovery step, so if you're not sure, download anything you
need first.

## Markdown specifics

Upload or paste a `.md` file and Pagelively:

1. Stores the original Markdown as-is.
2. Renders it to HTML for public serving (that's what visitors actually see).
3. Optionally links to the raw Markdown file, if you enabled **show source** — useful if you
   want readers to grab the original text.

Raw HTML written inside your Markdown is preserved by default (this is a personal-publishing
tool for content you wrote yourself, not a place to paste untrusted third-party Markdown).

## Understanding errors

Upload and edit forms show errors inline, in plain-ish language, but if you want to know
exactly what triggered one, here's the full list translated:

| What you'll see (or the underlying error code)                    | What it means                                                                                         | What to do                                                                                                                               |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Reserved/invalid slug (`invalid_slug`)                            | Your slug uses a reserved name (`admin`, `api`, …) or invalid characters, or it's empty after cleanup | Pick a different slug                                                                                                                    |
| Slug already in use (`slug_conflict`)                             | Another page already has that slug                                                                    | Choose a different slug, or edit the other page first                                                                                    |
| "Choose at least one file…" / `no_files`                          | You clicked Upload without selecting anything                                                         | Attach files, or use the Paste tab                                                                                                       |
| `ambiguous_entry`                                                 | Multiple documents/images were uploaded with nothing marking which is the entry                       | Normally the entry picker appears automatically for this case — if you see the raw error, retry from the upload form so the picker shows |
| Path/filename errors (`path_traversal`, `invalid_filename`)       | A file's name or path contains characters like `../`, a leading `/`, `\`, or `%`                      | Rename the file and re-upload                                                                                                            |
| Title too long (`title_too_long`)                                 | Title is over 256 characters                                                                          | Shorten it                                                                                                                               |
| Upload/paste too large (`request_too_large`, `content_too_large`) | Uploads are capped around 95 MB total; pasted content is capped at 1 MB                               | Resize/compress large media before uploading, or upload it as a file instead of pasting                                                  |
| "…cannot be deleted individually" (`entry_not_deletable`)         | You tried to delete the file that _is_ the page (its entry document, raw Markdown source, or image)   | Delete the whole page instead, if that's what you want                                                                                   |
| Forbidden / 403                                                   | Your Cloudflare Access session isn't valid (expired, or you're not signed in)                         | Reload the page to trigger sign-in again                                                                                                 |

## FAQ

**Is my content public?** By default, yes — anyone with the URL can view a `public` page.
Setting a page to `unlisted` doesn't remove it from the internet; it just means it's not shown
in any listing (there's no public listing of all pages by default anyway). Treat `unlisted` as
"not advertised," not "private."

**Can I use my own CSS, JS, images, or fonts?** Yes — upload them alongside your HTML/Markdown
(as loose files or inside a folder) and reference them with **relative** paths, e.g.
`<img src="images/photo.png">`. Root-relative paths like `/images/photo.png` won't resolve
correctly — always use a relative reference.

**How large can uploads be?** Roughly 95 MB total per upload request. Pasted content (the Paste
tab) is capped at 1 MB. For large images or video, resize/compress before uploading.

**Does editing a page change its URL?** No. The id never changes, and the slug only changes if
you deliberately edit it. Replacing files (including the entry document) republishes the same
page at the same URL.

**Can more than one person use this?** Pagelively is designed for a single operator, though the
Cloudflare Access policy created during setup can technically list more than one email address.
It has no concept of separate accounts, ownership, or permissions between users — everyone
allowed through Access has full access to every page.

**Where do I go to change my custom domain, add another admin email, or re-run provisioning?**
That's covered in the [operations guide](../operations/README.md) — those are deploy-time
changes, not something done from `/admin`.

**I changed a page's tags but the listing page hasn't updated. How long do I need to wait?**
Up to 5 minutes. Listing pages are edge-cached, and tag changes on individual pages don't
automatically flush the cached output of listing pages that reference those tags. The cache
expires within 5 minutes (see the [listing page section](#listing-pages) for details).
