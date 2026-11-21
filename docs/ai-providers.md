# AI Providers & Models

Configure AI authentication, model fallback order, thinking level, and timeouts under **Settings → AI**.

You can connect multiple providers at the same time—models from every connected provider become available in the model hierarchy below.

## Supported Providers

### Built-in Providers

| Provider | OAuth Sign-In | API Key / Token | Notes |
| --- | --- | --- | --- |
| **OpenAI Codex** | Device code (ChatGPT Plus/Pro) | — | Supports optional **Priority (Fast)** service tier |
| **Anthropic** | Copy code (Claude Pro/Max) | Yes | OAuth pauses for pasted authorization code |
| **OpenAI** | — | Yes | Standard OpenAI API models |
| **GitHub Copilot** | Device code | Yes | Supports optional GitHub Enterprise domain |
| **Google Gemini** | — | Yes | Uses a Google AI Studio API key (consumer Google AI subscriptions do not offer OAuth) |
| **OpenRouter** | — | Yes | Access multiple upstream models with one key |
| **xAI** | Device code (SuperGrok / X Premium) | Yes | Grok models |
| **DeepSeek** | — | Yes | DeepSeek API models |
| **Groq** | — | Yes | Hosted open-weight models |
| **Mistral** | — | Yes | Mistral API models |
| **Kimi Code** | Device code | Yes | Kimi Code subscription or API key |

### Custom OpenAI / Anthropic-Compatible Endpoints

Choose **Custom endpoint** in **Settings → AI** to connect local or self-hosted servers (such as Ollama, LiteLLM, vLLM, LM Studio, or an internal gateway):

- **Provider ID:** Lowercase alphanumeric + hyphens (`^[a-z0-9][a-z0-9-]{0,47}$`), e.g. `ollama` or `litellm`.
- **Base URL:** Full `http://` or `https://` endpoint URL (e.g., `http://ollama.local:11434/v1`).
- **API compatibility:** `openai-completions`, `openai-responses`, or `anthropic-messages`.
- **API key:** Optional—uncheck **Requires API key** for keyless local servers like Ollama.
- **Models:** Add one or more model IDs (with optional display name, reasoning flag, context window, and max tokens).

Custom endpoint definitions are stored in `/config/pi/models.json`, and credentials are stored in `/config/pi/auth.json`.

## Model & Fallback Hierarchy

Under **AI model & fallback hierarchy**:

1. Choose your **#1 Primary** provider and model.
2. Optionally click **Add fallback model** to add up to 10 ordered fallbacks (**#2 Fallback**, **#3 Fallback**, …).
3. Reorder models with the up/down arrows or remove fallbacks you no longer want.
4. Click **Save changes** in the bottom save bar.

### How Automatic Fallback Works

- Every repair turn starts with your **#1 Primary** model.
- If a model fails **before taking any side-effect actions** (for example due to quota exhaustion, rate limits, provider outage, or an unavailable model), Plex Repairman automatically retries the turn with the next model in the hierarchy.
- Fallback **never** replays a turn after side-effect tools have already executed or after a user/task cancellation, preventing duplicate grabs, deletions, or notifications.
- Available built-in models come from the Pi SDK plus its cached remote model catalog overlay (`/config/pi/models-store.json` or fallback `/config/pi/models-catalog.json`).

## Testing Models

Each row in the **AI model & fallback hierarchy** has an inline **Test** button (flask icon). Clicking **Test** sends a minimal probe request directly to that provider and model (even before saving changes) and displays either latency + `OK` or the unwrapped provider error message.

## Model Behavior & Timeouts

| Setting | Default | Range / Options | Notes |
| --- | --- | --- | --- |
| **Thinking level** | `medium` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` | Controls reasoning effort on models that support reasoning. |
| **Service tier** | `Default` | `Default`, `Priority (Fast)` | Applied only to OpenAI Codex payloads; ignored by other providers. |
| **Standard timeout** | `60` s | `5` – `600` s | Timeout for routine Plex/Sonarr/Radarr/Seerr API calls. |
| **Release lookup timeout** | `300` s | `15` – `900` s | Timeout for slower indexer/release searches in Sonarr and Radarr. |

## Model Attribution in the Portal

To make it clear which model actually handled each request (and whether a fallback kicked in):

- **Overview** shows active connected providers and configured primary/fallback status.
- **Repairs** and **Repair timelines** record the provider/model used for each turn and flag when a fallback model handled the response.
- **Agent tasks** show the provider/model used for each worker run.

## Credential Storage & Recovery

- OAuth tokens and API keys are managed by the Pi runtime in `/config/pi/auth.json`.
- If an OAuth refresh fails, the provider card surfaces the refresh error and lets you click **Reconnect OAuth** without losing other providers or settings.
- Back up `/config/pi/` together with `/config/plex-repairman.db` and `/config/secrets.key` (see [Operations & Troubleshooting](operations.md#backups-upgrades-and-rollback)).
