# SpinView Website Content Architecture

## Purpose

This document defines the content architecture for the SpinView website.

The goal is to keep the website easy to maintain while allowing new games, apps, experiments, and SpinFX entries to be added without manually editing `index.html`.

The website should remain mostly static and lightweight.

The core idea is:

- Public applications live at the website root.
- Website metadata and presentation assets live under `/_data/`.
- Each project has its own `project.json`.
- A small C99 tool scans `/_data/` and generates `/_data/catalog.json`.
- The main SpinView website loads `catalog.json` and dynamically renders projects, featured items, categories, and SpinFX entries.

---

# 1. High-Level Structure

Recommended structure:

```text
root/
│
├── index.html
│
├── generate_catalog.bat
│
├── tools/
│   └── catalog_builder.c
│
├── _data/
│   ├── game/
│   │   └── numeris/
│   │       ├── project.json
│   │       ├── icon.webp
│   │       ├── cover.webp
│   │       └── screen/
│   │           ├── 01.webp
│   │           ├── 02.webp
│   │           └── 03.webp
│   │
│   ├── app/
│   │   ├── deitouch/
│   │   │   └── project.json
│   │   └── holophone/
│   │       └── project.json
│   │
│   ├── experiment/
│   │   └── raytracer/
│   │       ├── project.json
│   │       └── cover.webp
│   │
│   ├── spinfx/
│   │   ├── 001/
│   │   │   ├── project.json
│   │   │   └── cover.webp
│   │   └── 002/
│   │       ├── project.json
│   │       └── cover.webp
│   │
│   └── catalog.json
│
├── numeris/
│   ├── index.html
│   ├── data.wasm
│   ├── game.js
│   └── other runtime files...
│
├── raytracer/
│   ├── index.html
│   └── other runtime files...
│
└── other public projects...
```

---

# 2. Fundamental Separation

There are two different concepts that must remain separate.

## `/_data/`

`/_data/` contains information used by the SpinView website to present projects.

Examples:

```text
/_data/game/numeris/project.json
/_data/game/numeris/icon.webp
/_data/game/numeris/cover.webp
/_data/game/numeris/screen/01.webp
```

This data belongs to the SpinView portal.

It is not the Numeris runtime.

## Public application folders

Actual applications live directly under the website root.

Example:

```text
/numeris/index.html
/numeris/data.wasm
/numeris/game.js
```

Therefore:

```text
/_data/game/numeris/
```

means:

> Metadata and promotional content used by SpinView to present Numeris.

While:

```text
/numeris/
```

means:

> The actual playable Numeris application.

Never place required game runtime files under `/_data/`.

For example, this is correct:

```text
/numeris/data.wasm
```

This is not recommended:

```text
/_data/game/numeris/data.wasm
```

---

# 3. Why `_data`

The `_data` directory is the internal content area used by SpinView.

It contains:

- project metadata
- project icons
- project covers
- screenshots
- SpinFX metadata
- generated catalog information

It should not contain application runtime code unless that code is specifically part of the website presentation layer.

The underscore is intentional because `_data` is visually easy to find near the top of a directory listing and clearly distinguishes internal website content from public application routes.

---

# 4. Project Categories

Projects are grouped by directory type.

Current supported directories:

```text
/_data/game/
/_data/app/
/_data/experiment/
/_data/spinfx/
```

Additional types may be added later.

Examples:

```text
/_data/game/numeris/
/_data/app/deitouch/
/_data/experiment/raytracer/
/_data/spinfx/105/
```

Each project directory contains a `project.json`.

---

# 5. `project.json`

Each project is self-contained.

Example:

```text
/_data/game/numeris/project.json
```

Example content:

```json
{
    "id": "numeris",
    "title": "Numeris",
    "type": "game",
    "collection": "spinmind",
    "status": "live",

    "description": "Cross-math puzzles inside an evolving visual world. Solve, progress and share your branch.",

    "icon": "icon.webp",
    "cover": "cover.webp",

    "screens": [
        "screen/01.webp",
        "screen/02.webp",
        "screen/03.webp"
    ],

    "tags": [
        "Puzzle",
        "SpinMind"
    ],

    "play": "/numeris/",
    "url": "/projects/numeris.html",

    "visible": true,

    "featured": true,
    "featured_order": 1,
    "featured_kicker": "SpinMind · Live"
}
```

---

# 6. Relative Asset Paths

Asset paths inside `project.json` should be relative to the directory containing `project.json`.

For example:

```json
{
    "cover": "cover.webp",
    "icon": "icon.webp"
}
```

For:

```text
/_data/game/numeris/project.json
```

the generated runtime paths become:

```text
/_data/game/numeris/cover.webp
/_data/game/numeris/icon.webp
```

Screenshots work the same way.

Example:

```json
{
    "screens": [
        "screen/01.webp",
        "screen/02.webp"
    ]
}
```

resolves to:

```text
/_data/game/numeris/screen/01.webp
/_data/game/numeris/screen/02.webp
```

Do not require authors to write full absolute asset paths inside every `project.json`.

---

# 7. `_base`

The catalog generator should automatically add an internal `_base` field to each generated entry.

Example generated entry:

```json
{
    "id": "numeris",
    "title": "Numeris",
    "type": "game",

    "cover": "cover.webp",
    "icon": "icon.webp",

    "play": "/numeris/",

    "_base": "/_data/game/numeris/"
}
```

The website can then resolve assets with a helper such as:

```javascript
function resolveAsset(item, path)
{
    if (!path)
        return "";

    if (/^(https?:)?\/\//i.test(path) || path[0] === '/')
        return path;

    return item._base + path;
}
```

Therefore:

```text
_base = /_data/game/numeris/
cover = cover.webp
```

becomes:

```text
/_data/game/numeris/cover.webp
```

---

# 8. Public Links Are Different From Assets

Fields such as:

```json
{
    "play": "/numeris/",
    "url": "/projects/numeris.html"
}
```

are public links.

They must not be resolved relative to `_base`.

The distinction is:

### Relative presentation assets

```text
cover
icon
screens
```

These normally use `_base`.

### Public navigation links

```text
play
url
youtube
download
```

These are explicit URLs and must be used directly.

---

# 9. Linking Catalog Entries to Root Applications

The connection between:

```text
/_data/game/numeris/
```

and:

```text
/numeris/
```

is made through the `play` property.

Example:

```json
{
    "id": "numeris",
    "play": "/numeris/"
}
```

Flow:

```text
/_data/game/numeris/project.json
            ↓
      "play": "/numeris/"
            ↓
       catalog.json
            ↓
        index.html
            ↓
     PLAY NUMERIS button
            ↓
 https://spinview.app/numeris/
```

---

# 10. Optional Automatic Play URL Convention

The catalog builder may optionally infer a public play URL when one is not explicitly specified.

Example:

```text
/_data/game/numeris/project.json
```

could imply:

```text
/numeris/
```

This should only happen for appropriate project types such as games or apps.

Explicit configuration must always take priority.

Example:

```json
{
    "play": "/special/numeris/"
}
```

must override any inferred path.

Recommended rule:

```text
explicit play value
    has priority over
automatically inferred play path
```

---

# 11. Generated Catalog

The generator scans the content directories and creates:

```text
/_data/catalog.json
```

The browser should load one consolidated catalog rather than loading every `project.json` individually.

This minimizes HTTP requests and scales better when SpinView contains many SpinFX entries.

Example:

```json
{
    "generated": "2026-08-20T16:00:00",

    "projects": [
        {
            "id": "numeris",
            "title": "Numeris",
            "type": "game",
            "collection": "spinmind",
            "status": "live",

            "description": "Cross-math puzzles inside an evolving visual world.",

            "cover": "cover.webp",
            "icon": "icon.webp",

            "play": "/numeris/",

            "visible": true,
            "featured": true,
            "featured_order": 1,

            "_base": "/_data/game/numeris/"
        }
    ],

    "spinfx": [
        {
            "id": "spinfx-105",
            "number": 105,
            "title": "Depth Study",
            "type": "spinfx",
            "cover": "cover.webp",
            "visible": true,
            "_base": "/_data/spinfx/105/"
        }
    ]
}
```

---

# 12. Catalog Generator

The catalog must be generated by a small C99 command-line tool.

Recommended files:

```text
/generate_catalog.bat
/tools/catalog_builder.c
```

Do not require:

- Node.js
- npm
- Python
- PowerShell
- third-party scripting runtimes

The generator should be a normal C99 program suitable for Windows.

TCC may be used to compile it.

---

# 13. `generate_catalog.bat`

The batch file should remain simple.

Example concept:

```bat
@echo off

tcc tools\catalog_builder.c -o tools\catalog_builder.exe

if errorlevel 1 (
    echo Catalog builder compilation failed.
    pause
    exit /b 1
)

tools\catalog_builder.exe

if errorlevel 1 (
    echo Catalog generation failed.
    pause
    exit /b 1
)

echo Catalog generated successfully.
pause
```

The C program performs all filesystem scanning, JSON processing, validation, sorting, and catalog generation.

The `.bat` file is only a launcher/build helper.

---

# 14. Catalog Builder Responsibilities

`catalog_builder.c` should:

1. Start from the website root.
2. Scan:

```text
_data/game/
_data/app/
_data/experiment/
_data/spinfx/
```

3. Recursively find `project.json`.
4. Parse every valid project.
5. Determine its `_base` path.
6. Copy project metadata into the generated catalog.
7. Exclude entries where:

```json
"visible": false
```

if desired at generation time, or preserve them and let the website filter them.
8. Sort featured projects by `featured_order`.
9. Sort SpinFX by descending `number`.
10. Write valid UTF-8 JSON to:

```text
_data/catalog.json
```

11. Report malformed JSON files clearly.
12. Continue gracefully when optional category directories are missing.
13. Return a non-zero process exit code on serious generation errors.

---

# 15. Visibility

A project can be prepared without publishing it.

Example:

```json
{
    "visible": false
}
```

The website must not display invisible projects.

If `visible` is absent, default to:

```text
true
```

This makes project files shorter.

---

# 16. Featured Projects

Featured carousel entries must come from the catalog.

Example:

```json
{
    "featured": true,
    "featured_order": 1,
    "featured_kicker": "SpinMind · Live"
}
```

The website should:

1. select items where `featured == true`
2. ignore invisible items
3. sort them by `featured_order`
4. generate carousel slides dynamically

The carousel may use:

- cover
- title
- description
- featured_kicker
- play
- url
- status

If `play` is missing, do not create a Play button.

If `url` is missing, do not create a View Project button.

---

# 17. SpinFX

SpinFX uses the same content architecture but may have additional fields.

Example:

```text
/_data/spinfx/105/project.json
```

```json
{
    "id": "spinfx-105",
    "number": 105,
    "title": "Depth Study",
    "type": "spinfx",

    "description": "A visual experiment exploring depth and motion.",

    "cover": "cover.webp",

    "youtube": "https://youtube.com/example",

    "visible": true,
    "featured": false,

    "date": "2026-08-20"
}
```

SpinFX entries should normally be sorted by descending `number`.

Example:

```text
107
106
105
104
...
```

Adding a new directory such as:

```text
/_data/spinfx/108/
```

and regenerating the catalog should automatically place it first.

---

# 18. Categories and Collections

The `type` field identifies the main project category.

Examples:

```json
"type": "game"
```

```json
"type": "app"
```

```json
"type": "experiment"
```

```json
"type": "spinfx"
```

A separate `collection` field may identify a broader SpinView collection.

Example:

```json
{
    "type": "game",
    "collection": "spinmind"
}
```

Numeris should then be eligible for filters such as:

```text
All
Games
SpinMind
```

The website must not assume that one project can only belong to one UI filter.

---

# 19. Status

Status should remain generic.

Possible values include:

```text
live
development
prototype
forming
coming-soon
```

Do not hardcode the entire system around only these values.

The website should tolerate additional status strings later.

---

# 20. Website Loading

The main website should load:

```text
/_data/catalog.json
```

using normal browser JavaScript.

Example:

```javascript
fetch("/_data/catalog.json")
```

The loaded catalog becomes the source of truth for:

- project cards
- featured carousel
- SpinFX cards
- category filters
- search
- project counts

Do not keep duplicate hardcoded project lists inside `index.html`.

---

# 21. Error Handling

The website must fail gracefully.

If:

```text
/_data/catalog.json
```

is missing, malformed, or unavailable:

- log a useful error to the browser console
- do not throw cascading JavaScript errors
- keep the page shell operational
- allow empty project sections if necessary

Missing optional assets should also fail gracefully.

If a cover image does not exist, hide it or use an existing site fallback.

---

# 22. Cache Handling

`catalog.json` changes when new projects are deployed.

The website should avoid serving stale catalog data for long periods.

If SpinView already has an existing `version.js` system, reuse it rather than creating another unrelated version mechanism.

Possible example:

```javascript
fetch("/_data/catalog.json?v=" + window.SPINVIEW_VERSION)
```

The exact implementation should integrate with the existing SpinView versioning logic.

---

# 23. SEO

Refactoring the content system must not remove existing SEO functionality.

Keep:

- `<title>`
- meta description
- canonical URL
- robots directives
- Open Graph metadata
- Twitter metadata
- JSON-LD
- semantic document structure

The main portal can render project listings dynamically, while individual public project pages remain important for direct indexing.

Example:

```text
https://spinview.app/numeris/
```

should remain a real public route.

---

# 24. Runtime Application Portability

Public applications should prefer relative runtime paths when practical.

Inside:

```text
/numeris/index.html
```

prefer:

```javascript
fetch("data.wasm");
```

instead of:

```javascript
fetch("/numeris/data.wasm");
```

Similarly:

```html
<script src="game.js"></script>
```

is preferable to tightly coupling the application to the SpinView root.

This makes the application easier to move later to another host or domain.

For example, Numeris could potentially move from:

```text
https://spinview.app/numeris/
```

to:

```text
https://numeris.app/
```

without rewriting every internal asset path.

---

# 25. Adding a New Game

Example workflow for a new game named `newgame`.

Create:

```text
/_data/game/newgame/
```

Add:

```text
project.json
icon.webp
cover.webp
screen/
```

Create the playable application separately:

```text
/newgame/
    index.html
    game.wasm
    game.js
```

Example project metadata:

```json
{
    "id": "newgame",
    "title": "New Game",
    "type": "game",

    "description": "Description of the project.",

    "icon": "icon.webp",
    "cover": "cover.webp",

    "play": "/newgame/",

    "visible": true
}
```

Run:

```text
generate_catalog.bat
```

Publish the resulting files.

No change to `index.html` should be necessary.

---

# 26. Adding a New SpinFX

Create:

```text
/_data/spinfx/106/
```

Add:

```text
project.json
cover.webp
```

Example:

```json
{
    "id": "spinfx-106",
    "number": 106,
    "title": "New SpinFX",
    "type": "spinfx",

    "description": "A new visual experiment.",

    "cover": "cover.webp",

    "visible": true
}
```

Run:

```text
generate_catalog.bat
```

The website should automatically display SpinFX 106 in the correct position.

No edit to `index.html` should be required.

---

# 27. Maintenance Workflow

The intended workflow is:

```text
1. Create or copy a project directory under _data.
2. Edit project.json.
3. Add the project's presentation assets.
4. Create/update the actual public application separately if applicable.
5. Run generate_catalog.bat.
6. Publish.
```

The main `index.html` should normally not need modification when new content is added.

---

# 28. Design Constraint

This architecture is a content refactor, not a visual redesign.

When adapting the existing SpinView website:

Do not unnecessarily change:

- visual design
- header
- logo
- navigation
- responsive behavior
- animations
- carousel appearance
- project card appearance
- SpinFX card appearance
- footer
- hover effects
- mobile layout

The main goal is to replace hardcoded content with data-driven rendering.

---

# 29. Implementation Principles for an LLM

When modifying this architecture, follow these rules:

1. Preserve the separation between `/_data/` and public application directories.
2. Do not move application runtime files into `/_data/`.
3. Treat `project.json` as the human-editable source for project metadata.
4. Treat `catalog.json` as generated output.
5. Do not manually edit `catalog.json` as part of normal content maintenance.
6. Keep relative presentation asset paths relative to each project's `_base`.
7. Keep navigation URLs explicit and independent from `_base`.
8. Prefer one consolidated catalog request over one browser request per project.
9. Keep the catalog generator dependency-free except for the local C compiler/toolchain.
10. Use C99 for the catalog generator.
11. Avoid C++ unless absolutely necessary.
12. Do not use lambdas.
13. Keep the generated website compatible with static hosting.
14. Do not introduce React, Vue, Node.js, npm, Python, PowerShell, or a CMS unless explicitly requested.
15. Preserve current SEO and frontend behavior unless a specific change is requested.
16. Favor simple conventions over unnecessary configuration.
17. Explicit configuration must override inferred defaults.

---

# 30. Core Mental Model

The simplest way to understand the architecture is:

```text
_data/
    describes projects

root project folders/
    run projects

catalog_builder.c
    discovers project descriptions

catalog.json
    combines project descriptions

index.html
    displays the catalog
```

For Numeris specifically:

```text
/_data/game/numeris/
    presentation metadata + website images

/numeris/
    actual playable application
```

Connected by:

```json
"play": "/numeris/"
```

This separation is intentional and should be preserved.
