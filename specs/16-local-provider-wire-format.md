# 16 — The local provider speaks the OpenAI wire format

Decided 2026-09-19. A small amendment to [12-pi-harness.md](12-pi-harness.md).
Spec 12 registered the local endpoint with pi as `"api": "anthropic-messages"`
pointed at the bare base URL, and named `openai-completions` as the fallback
"if `/v1/messages` doesn't slot cleanly". This spec takes that fallback as the
default, because for every self-hosted server but oMLX itself there is nothing
to slot into.

No locked decision changes. Decision 4 keeps one harness (pi in SDK mode) for
every provider, and the local provider stays optional; only the wire format it
is registered with, and the name it is shown under, change.

## Motivation

`anthropic-messages` is oMLX-shaped. vLLM, LM Studio, llama.cpp's server, SGLang
and the rest of the self-hosted field serve `/v1/chat/completions` and have no
`/v1/messages` to answer at all, so any endpoint other than oMLX 404'd on its
first request. The provider was documented as "local models" but only one server
could actually drive a loop.

Three smaller things failed with it:

- **The base URL was spelled two ways.** The Settings model picker appended
  `/v1`; the provider block did not. A base URL copied from a vLLM or LM Studio
  README already ends in `/v1`, so one of the two paths was always wrong.
- **The context window was a constant.** 200,000 tokens, which is not a number
  any local deployment serves. A window claimed larger than the server's does
  not fail at startup: it fails as a 400 several iterations into a loop, once
  context has grown past the real limit.
- **A wrong model id failed late and blankly.** Nothing asked the server what it
  was serving before registering the model.

## The decision

1. The local provider is registered as `openai-completions` against the `/v1`
   root of the configured base URL. `v1Root()` normalizes both spellings (with
   or without a trailing `/v1`, with or without a trailing slash), in one place.
2. Before registering, Radulf lists `/v1/models` and requires the configured
   model id to be present. The error for a miss names everything the server is
   actually serving.
3. The context window comes from the server (`max_model_len`, or
   `context_length` when that is what it reports), falling back to 32,768 when
   it reports neither: a number small enough to be safe against any plausible
   deployment, since it only has to be no larger than the truth for compaction
   to fire in time. `maxTokens` is derived from that window
   (`min(8192, max(1024, window / 4))`) rather than sitting next to it as an
   unrelated constant, because a server's budget covers prompt and completion
   together.
4. The provider's user-facing name becomes **Local / self-hosted
   (OpenAI-compatible)**, and the Settings fields become "Local server base URL"
   and "Local server API key". The docs name the servers people actually run
   (oMLX, vLLM, LM Studio) instead of implying one.

## What deliberately does not change

- **The provider id stays `omlx`**, as do the `omlxBaseUrl` / `omlxApiKey`
  settings columns. Renaming them is a migration plus a rewrite of every stored
  card override, bought for cosmetics. The id is internal; the label is what
  users read.
- **No auto-detection.** Radulf does not probe for `/v1/messages` and pick a
  format. One wire format, the one the whole field serves. oMLX serves it too.
- **Auth is unchanged**: an optional bearer token, defaulted to a dummy value
  because most local servers require none.

## Acceptance tests

- `omlxProviderConfig` builds `baseUrl` ending in `/v1`, `api:
  "openai-completions"`, the configured key or the fallback, and the model id.
  (`src/server/harness/pi.test.ts`)
- A served window of 65,536 gives `contextWindow: 65_536` and `maxTokens: 8_192`;
  a window of 8,192 gives `maxTokens: 2_048`; no reported window gives 32,768.
- `v1Root` accepts `http://host:8000`, `http://host:8000/`, `http://host:8000/v1`
  and `http://host:8000/v1/`, and tolerates surrounding whitespace.
  (`src/server/localEndpoint.test.ts`)
- `listLocalModels` reads ids from `/v1/models`, prefers `max_model_len`, falls
  back to `context_length`, omits the window when neither is reported, and names
  the URL it could not reach.

## Verified

vLLM 0.23.0 serving Qwen3-Coder-Next (NVFP4) with `--enable-auto-tool-choice
--tool-call-parser qwen3_coder`: plan, loop and evaluate all ran through to an
approved diff, with the 65,536-token window read from the server rather than
assumed.

## Amendments to prior specs and docs

- [12-pi-harness.md](12-pi-harness.md): the `models.json` sketch (line ~117) and
  checklist item 3 describe `anthropic-messages` with `openai-completions` as
  the fallback. That ordering is now reversed. The spec is left as the historical
  record; this file is the amendment.
- `README.md`, `docs/PROVIDERS.md`, `docs/GETTING_STARTED.md`,
  `docs/TROUBLESHOOTING.md` and `docs/WHAT_IS_RADULF.md` name the provider
  "Local / self-hosted" and document the `/v1` base URL, the tool-use
  requirement, and the served context window.
