<p align="center">
  <img src="docs/assets/logo.svg" width="88" height="88" alt="PromptCut logo">
</p>

<h1 align="center">PromptCut Lite</h1>

<p align="center">
  <strong>Tell an AI agent how to cut your video, then take over by hand whenever you like.</strong>
</p>

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/English-00A3A3?style=for-the-badge" alt="English"></a>
  <a href="README.zh-CN.md"><img src="https://img.shields.io/badge/简体中文-3a3f4b?style=for-the-badge" alt="简体中文"></a>
  <a href="README.ja.md"><img src="https://img.shields.io/badge/日本語-3a3f4b?style=for-the-badge" alt="日本語"></a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-6F69FC" alt="MIT license"></a>
  <a href="https://github.com/Nice9Tian/PromptCut_Lite/actions/workflows/test.yml"><img src="https://github.com/Nice9Tian/PromptCut_Lite/actions/workflows/test.yml/badge.svg" alt="Test status"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2022-00A3A3" alt="Node.js 22 or newer">
  <img src="https://img.shields.io/badge/desktop-Windows%20x64-3a3f4b" alt="Desktop app: Windows x64">
  <a href="CONTRIBUTING.en.md"><img src="https://img.shields.io/badge/PRs-welcome-00A3A3" alt="PRs welcome"></a>
</p>

<p align="center">
  <a href="#ways-to-work">Ways to work</a> ·
  <a href="#what-it-does">What it does</a> ·
  <a href="#getting-started">Getting started</a> ·
  <a href="#documentation">Documentation</a> ·
  <a href="CONTRIBUTING.en.md">Contributing</a>
</p>

<p align="center">
  <img src="docs/assets/vibe-en.webp" width="900" alt="PromptCut in Vibe mode: projects on the left, the chat with the agent in the middle, the rendered picture on the right">
</p>

PromptCut is an AI video-editing workbench: you direct an agent in plain language, and you can also cut and tune parameters by hand — both at the same time, on the same project.

**This is the Lite edition**: single user, single machine, local desktop only (the desktop app and a local desktop browser). It has no accounts, no cloud projects, no multi-user collaboration, no LAN and no mobile build. Everything here runs on your own machine; there is nothing to sign up for and no server to talk to. For LAN collaboration and phones, use the [community edition](https://github.com/Nice9Tian/PromptCut_Community).

## Ways to work

You can switch between these on the same project at any time, and nothing is lost.

| Mode | How it works |
|---|---|
| **Vibe mode** | No editor in the way. Say one sentence on the start page and the agent builds the project. Follow it on the chat page, watch the picture and the before/after changes in the side panel, and open detail editing when you want to adjust the timeline yourself. |
| **Classic mode** | The full editor: media library, preview, timeline and the AI panel side by side, for you and the agent to work on together. |
| **SKILL mode** | Desktop app only. An agent running in your desktop connects over MCP while the editor stays closed and PromptCut runs in the background. Open the editor whenever you want to step in. |

<p align="center">
  <img src="docs/assets/classic-en.webp" width="900" alt="PromptCut in Classic mode: media library on the left, preview in the middle, AI panel on the right, timeline below">
</p>

## What it does

| | |
|---|---|
| **Vibe mode** | Describe the video you want and get a first cut, without opening the editor. Keep directing it in chat, and adjust the timeline in detail editing. |
| **Agent-directed editing** | Talks to a local CLI or API agent that lays out the timeline, adds cards and tunes parameters. It also acts as an MCP server other agents can call. |
| **Manual editing** | Timeline, multiple tracks, nested cuts, parameter panels and preview. |
| **Cards** | Motion graphics, charts, captions and more, implemented as React components. A built-in library ships with the app, and you can write your own. |
| **Rendering and output** | Prerendered snapshots, frame-by-frame rendering in a local Chrome, and a final video composed with ffmpeg. |
| **Media** | Local import, fetching from web links (yt-dlp), shot-boundary detection, subject detection, point tracking and speech-to-text. |
| **Languages** | The interface comes in English, Simplified Chinese and Japanese. It follows your system language the first time and can be switched from the language menu at any time; your open project stays where it was. |
| **Desktop app** | A Tauri v2 shell that packages Node, Chrome for Testing, ffmpeg and a bundled Python into a single Windows installer. |

## Getting started

You need Node.js ≥ 22 (24.x recommended). Exporting a final video also needs ffmpeg on `PATH` (on Windows: `winget install --id Gyan.FFmpeg -e`).

```bash
npm ci
npm run dev        # local editor at http://127.0.0.1:5190
```

| Command | What it does |
|---|---|
| `npm run dev` | Starts the local editor. The backend lives in this Vite dev server's plugin middleware, so the dev server is the app, not just a bundler. |
| `npm test` | Full unit-test suite |
| `npm run build` | Type-checks, then builds |
| `npx tsc -b` | Type-check only |

The Python side (speech-to-text, shot detection, subject detection, tracking, media collection) installs its dependencies and model weights on demand and reports honestly in `status` when something is missing. See [python/README.md](python/README.md). To build the desktop app, see [desktop/README.md](desktop/README.md).

## Documentation

The documentation is written in Chinese. `docs/semantics/` is the project's **contract**: where the semantics and the code disagree, the semantics win. Before changing code, use the table in [docs/semantics/README.md](docs/semantics/README.md) to find which documents govern your change.

| Topic | Where |
|---|---|
| Why the product exists, what it aims at | [docs/semantics/product-purpose.md](docs/semantics/product-purpose.md) |
| What the system is made of | [docs/semantics/architecture.md](docs/semantics/architecture.md); product-level promises in [product/](docs/semantics/product/), mechanisms in [mechanism/](docs/semantics/mechanism/) |
| How people use it | [docs/semantics/user-workflow.md](docs/semantics/user-workflow.md), details in [workflow/](docs/semantics/workflow/) |
| Glossary | [docs/semantics/glossary.md](docs/semantics/glossary.md) |
| Design rationale | [docs/rationale/](docs/rationale/) |
| Troubleshooting and operational know-how | [docs/guides/](docs/guides/) |
| How to contribute | [CONTRIBUTING.en.md](CONTRIBUTING.en.md) |

<details>
<summary><strong>References that point outside this repository</strong></summary>

Comments and semantics documents occasionally cite things this repository does not contain. There are two kinds:

- **Upstream internal documents**: `docs/plan/…` (plans and contracts), `docs/reports/…` (acceptance reports), and `docs/local.md` (per-machine notes, never committed to any repository by design, see `docs/semantics/guide_files/constraints.md`).
- **Commercial-edition-only code**: paths such as `src/online/…`, `src/account/…`, `server/account/…`, `server/hosted/…`, and compile-time constants like `ONLINE_BUILD` that are always false here.

Both kinds are kept deliberately: they record where a decision came from, and the comment itself already states the conclusion, so not being able to open the cited file does not stop you understanding the code. These citations will be rewritten in both editions once upstream has pulled the local/cloud seam apart (see the area table in [CONTRIBUTING.en.md](CONTRIBUTING.en.md)). Fixing them only here would make the same file differ between the two editions, which is exactly what we are trying to avoid.

</details>

<details>
<summary><strong>For coding agents</strong></summary>

This repository deliberately ships no `AGENTS.md` or `CLAUDE.md`: tools inject those files into context unconditionally, which would push this project's working habits into other people's agents. If you want one, create it in your working copy with the text below and do not commit it (`.gitignore` already covers it):

````markdown
# PromptCut

An AI video-editing workbench. Before changing this repository, know these things:

- The semantics live in `docs/semantics/`: product promises in `product/`, mechanisms in `mechanism/`, user flows in `workflow/`. Where semantics and code disagree, the semantics win.
- The hard constraints are in `docs/semantics/guide_files/constraints.md` and must be followed. Layering is kernel ← render ← editor / mcp / ai; lower layers never import upper ones, and a gatekeeper test enforces it.
- How to verify, and which check each kind of change must run, is in `docs/semantics/guide_files/verification.md`.
- Which semantics to read for a given change is in `docs/semantics/README.md`.
````

</details>

## License and name

The code is licensed under [MIT](LICENSE), but **the name "PromptCut" and the associated marks are not part of that license**. You are free to fork, modify and redistribute. Please do not call your distribution "PromptCut", so that users do not mistake it for an official release.
