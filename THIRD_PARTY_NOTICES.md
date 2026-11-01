# Third-party notices

## CopilotKit/OpenBot: agent-computer (MIT)

OpenDuet's computer (`computer` service in `compose.yml`) is built from https://github.com/CopilotKit/OpenBot at commit `da9a3caf5784074baa779110dd7e9d1338c8871b` (its `agent-computer/` sources, by `computer/Dockerfile`, which mirrors upstream's `agent-computer/Dockerfile`), with our patches in `computer/patches/` (whole-window live screen, X input, OpenDuet's pointer, following the selected tab, workspace writes while a person holds the browser, the landscape default with an optional portrait headless page, the tab routes, Chromium's popup blocker left on, and the command runner that runs `computer_exec` in the separate `computer-exec` service) applied on top; new files there say so in their header. Patch 0006 also takes code from OpenBot's newer agent-computer 0.2.0 (same copyright and license): the live screen's keyboard fix in `src/screencast.ts` (no `nativeVirtualKeyCode`, with its explanation), its real-browser test `tests/screencast-keys-browser.test.ts` (ported unchanged but for the header), and the tab listing in `src/bot-tabs.ts` (adapted from `src/browser-host.ts`). `backend/src/computer/health.ts` and `backend/src/cli/smoke.ts` call its HTTP API.

```
MIT License

Copyright (c) 2026 CopilotKit

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## CopilotKit/OpenDuet (MIT)

Some of the M20 safety rules follow CopilotKit/OpenDuet (built on OpenBot; same copyright and MIT License as above): the safety floor of tools that always ask (payments, credentials, security settings), "Always" limited to one recipient for tools that send to other people, no second card for a request already waiting or just declined, and the credential check on arguments sent to connectors. The M23 mail triage for the morning brief and check-ins (`backend/src/proactive/triage.ts`: narrow can-wait rules first, then a model verdict with a reason for each email) is adapted from its `openbot/server/src/openduet/triage.ts`. Files that adapt a pattern or list from it say so in their header.

## OpenDots (MIT)

Building the computer from a pinned OpenBot git context (`https://github.com/CopilotKit/OpenBot.git#<commit>`, since M20b given to `computer/Dockerfile` as the named build context `upstream`) follows OpenDots' `compose.computers.yml`.

```
The MIT License

Copyright (c) Atai Barkai

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Stripe smokescreen (MIT)

The `egress` image (`egress/Dockerfile`) builds https://github.com/stripe/smokescreen v0.1.0 (commit `609eb8931420453daf5893509be0b25b21bd9edb`) from source, unmodified; the license ships in the image at `/usr/share/licenses/smokescreen/LICENSE.txt`.

```
Copyright (c) 2016 Stripe

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Built-in skills (M25)

openduet bundles the following skill instructions in `backend/skills-builtin/`. Upstream licenses and any NOTICE are kept in each skill directory. Modified files are marked and their changes recorded in CHANGES.md. These skills do not imply upstream endorsement.

| Skill | Source repository / path | Full commit | License | openduet changes |
|---|---|---|---|---|
| skill-creator | https://github.com/anthropics/skills · `skills/skill-creator` | `dbd4588f9e1033efb41dad4bef2f7947c8993d44` | Apache-2.0 | Rewritten: ask → SKILL.md → one example → propose_skill; keeps the guidance on descriptions and progressive disclosure; leaves out subagents, eval viewers, assets, references, Python packaging and the `claude -p` scripts. |
| frontend-design | https://github.com/anthropics/skills · `skills/frontend-design` | `dbd4588f9e1033efb41dad4bef2f7947c8993d44` | Apache-2.0 | Copied unchanged. |
| theme-factory | https://github.com/anthropics/skills · `skills/theme-factory` | `dbd4588f9e1033efb41dad4bef2f7947c8993d44` | Apache-2.0 | Adapted to unattended Make builds and local fonts; keeps the ten text themes; leaves out theme-showcase.pdf and the interactive confirmation. No fonts bundled. |
| officecli | https://github.com/iOfficeAI/OfficeCLI · root `SKILL.md` | `5e625bf58aca732335590d7aa271f6337535a7ef` | Apache-2.0 | Removed the installation, specialized-skill loading and watch-server sections; adapted the resident / PDF guidance to the pinned computer image. No subskills bundled; LICENSE and NOTICE kept. |
| explore-data | https://github.com/anthropics/knowledge-work-plugins · `data/skills/explore-data` | `2574e29377c7173d0cecffef29a6ecbd7f8ccb5d` | Apache-2.0 | Replaced plugin / slash-command assumptions with openduet's tools; only the skill text and data/LICENSE are bundled, no MCP or plugin configuration. |
| task-management | https://github.com/anthropics/knowledge-work-plugins · `productivity/skills/task-management` | `2574e29377c7173d0cecffef29a6ecbd7f8ccb5d` | Apache-2.0 | Rewritten around openduet's tasks and proposal cards; removed TASKS.md, the dashboard setup and history deletion. |
| meeting-minutes-taker | https://github.com/daymade/claude-code-skills · `daymade-audio/meeting-minutes-taker` | `13f42792f4301d3e42437c552ab85ea1388a4f64` | MIT, © 2025 daymade | Removed `disable-model-invocation`; added openduet tool / sequential-review notes; keeps three references unchanged. |

The `pdf` skill is original openduet text, not copied from an upstream skill. It describes the computer image's Playwright / Chromium and unpdf workflow. No Anthropic proprietary docx / pdf / pptx / xlsx skills are included.

## Services the built-in tools call (M25)

The key-less built-in tools call these services at run time; nothing of theirs is bundled. `web_search` (no `SEARCH_PROVIDER` set): Exa's MCP search (https://exa.ai/terms), then Parallel's Search MCP (https://parallel.ai/terms-of-service, https://parallel.ai/acceptable-use-policy) on failure; both document free, rate-limited use without a key. `weather`: Open-Meteo (https://open-meteo.com/en/terms); the free API is for non-commercial use, data under CC BY 4.0, credited as "Weather data by Open-Meteo.com". `exchange_rate`: Frankfurter (https://frankfurter.dev), European Central Bank reference rates. `read_feed` fetches the feed's own URL.

## Programs installed in OpenDuet's computer

Installed from Ubuntu 24.04 packages as separate programs, not linked into our code: FFmpeg (LGPL-2.1+ / GPL-2+; Ubuntu's build includes GPL parts), xdotool (BSD-3-Clause), xclip (GPL-2.0+), Git (GPL-2.0), Python 3 (PSF License 2.0), GNU patch (GPL-3.0+) and Xvfb (X.Org, MIT/X11). Their sources are Ubuntu's source packages for the same versions (`apt-get source <package>` on Ubuntu 24.04). The Node package unpdf 1.9.1 (MIT) is installed from `computer/js/`.

OfficeCLI 1.0.159 (iOfficeAI/OfficeCLI, Apache-2.0) is built from source at commit `5e625bf58aca732335590d7aa271f6337535a7ef` without eight of its bundled skills, with auto-update and auto-install turned off; it bundles the Open XML SDK, System.CommandLine and the .NET runtime (MIT). Its LICENSE, NOTICE and THIRD-PARTY-NOTICES.txt are in the image at `/usr/local/share/doc/officecli/`.

## Images used as published

Pinned by digest in the Dockerfiles and `compose*.yml`, under their own licenses: `oven/bun` (Bun, MIT), `caddy` (Apache-2.0), `cloudflare/cloudflared` (Apache-2.0), `golang` (build stage only, BSD-3-Clause), `mcr.microsoft.com/dotnet/sdk` (OfficeCLI's build stage only, MIT), `alpine`, and the Ubuntu, Node.js, Playwright (Apache-2.0) and Chromium (BSD-3-Clause and others) layers of the computer image. Backend npm dependencies are listed with their licenses in `backend/bun.lock` and `backend/node_modules/*/package.json`.
