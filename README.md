# Island Palace

**English** | [简体中文](README.zh-CN.md)

> A standalone 3D memory-palace builder that runs in your browser: build a house, grow it into an island town, zoom out to an archipelago — and further, until the whole world curls into a tiny planet.

Island Palace is a fork of [KMind Palace](https://github.com/suka233/kmind-palace) by suka. The fork keeps the 3D builder and removes everything else: no notes, no recall sessions, no spaced repetition, no AI stories, no number encodings, no visitors, no onboarding. What is left is a place to build — palaces, furniture, rooms, a whole world, and a pet to live in it.

## What you can do

- 🏝 **Build a world** — an island town → archipelago → tiny planet; four scene themes (island, forest, snow peaks, sky islands) and a day/night toggle.
- 🏗 **Build mode** — add rooms, walls, doors and windows, then furnish them from the catalog: move, rotate and fine-tune every piece (size, colors, mount points).
- 📷 **Recognize furniture from a photo** — hand it a photo of a piece of furniture and a vision model turns it into an object in the catalog's style. Optional: point it at your own OpenAI-compatible endpoint.
- 📦 **Bring your own models and photos** — import `.glb` models and use your own images as media.
- 🦉 **Your pet** — five species with colors and accessories; it lives on your island and follows you.
- 🔒 **Everything stays in your browser** — palaces, the world and media are saved locally; no account, no server, no telemetry.
- 🌍 **English and Simplified Chinese** — the interface follows your browser language.

## Run it

Requires Node.js 22+ and pnpm.

```bash
pnpm install
pnpm dev                      # the app at http://127.0.0.1:5181 (?lang=en for English)
pnpm typecheck && pnpm test   # TypeScript check and the unit tests
```

## Repository layout

```
packages/
  core/   the whole app: palace data format, three.js scene, UI and interaction
```

**Translations**: UI text goes through `t('中文原文')`, with the English dictionary in `packages/core/src/i18n/en/`; `pnpm -C packages/core i18n` lists anything that has no translation yet, and the test suite fails on it.

## Network use

- **Photo → furniture recognition** is optional and sends the photo only to the OpenAI-compatible endpoint you configure. Nothing is configured by default.
- Because the page calls that endpoint directly from the browser, it has to allow cross-origin requests: OpenAI's API does; a local Ollama needs `OLLAMA_ORIGINS` set to this page's origin.
- Nothing else talks to a server: no telemetry, no analytics. Your palaces never leave your browser.

## License

[Mozilla Public License 2.0](LICENSE): use, modify and distribute freely (including in commercial and closed-source products); if you distribute modified versions of files from this repository, publish those modifications.

Upstream [KMind Palace](https://github.com/suka233/kmind-palace) is © suka and is also licensed under the MPL-2.0. Its name ("KMind Palace" / "思维宫殿") and icon are **not** covered by the license — and neither is this fork's own name ("Island Palace" / "岛屿宫殿") or icon, which do not come from upstream.
