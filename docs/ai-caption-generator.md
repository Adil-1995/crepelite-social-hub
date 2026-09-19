# AI caption generator

Generates social captions from the media a post already carries, defaulting to
**Moroccan Darija written in Arabic script**.

The model proposes; it never publishes. Nothing it produces reaches a network
without a person choosing it.

---

## Flow

```
Composer → ✨ Generar con IA
   → (video only) browser extracts 3 frames
   → generateCaption callable
        ├─ role check (content.write)
        ├─ workspace AI settings
        ├─ quota reserved
        ├─ media read from Storage with the admin SDK
        └─ provider → model
   → suggestions shown as cards
   → user edits / rewrites / picks
   → inserted into the master caption
   → ✨ Adaptar a plataformas (optional)
        └─ one variant per destination, written into PostVariant
   → user schedules or publishes as normal
```

## Architecture

| Piece | Where |
| --- | --- |
| Types, settings, language and tone lists | `shared/src/ai/types.ts` |
| Request schemas | `shared/src/schemas/api.ts` |
| Provider contract | `functions/src/ai/types.ts` |
| Registry | `functions/src/ai/registry.ts` |
| Prompts | `functions/src/ai/prompts.ts` |
| OpenAI implementation | `functions/src/ai/openai/openaiProvider.ts` |
| Mock, for tests | `functions/src/ai/mock/mockAiProvider.ts` |
| Quota | `functions/src/ai/quota.ts` |
| Callables | `functions/src/api/ai.ts` |
| Dialog | `src/components/domain/AiCaptionDialog.vue` |
| Video frames | `src/composables/useVideoFrames.ts` |
| Settings | Settings → AI content |

`AIContentProvider` mirrors `SocialProvider`: the callables ask the registry
and never name a vendor, so changing model provider is a registration change.

```ts
interface AIContentProvider {
  isConfigured(): boolean;
  missingConfiguration(): string[];
  generateCaption(...): Promise<AiCaptionOutput>;
  rewriteCaption(...): Promise<AiRewriteOutput>;
  adaptCaptionToPlatforms(...): Promise<AiAdaptOutput>;
}
```

### Changing provider

1. Implement `AIContentProvider` under `functions/src/ai/<vendor>/`.
2. Register it in `functions/src/ai/registry.ts`.
3. Set `AI_PROVIDER=<id>` and its key in Secret Manager.

Nothing else changes — not the dialog, not the composer, not the schemas.

---

## Darija

This is the part that decides whether the output is usable.

Asking a model for "Arabic" reliably produces Modern Standard Arabic, which in
a caption reads like a government notice. `prompts.ts` therefore:

- names the register explicitly (الدارجة المغربية, Arabic script);
- lists everyday Moroccan vocabulary to prefer — بزاف, دابا, واش, شنو, غادي;
- **bans the MSA giveaways** by name: يسرنا, نقدم لكم, ذات مذاق رائع;
- forbids word-for-word translation from French or Spanish;
- gives worked examples of both the target voice and the failure mode.

Target:

```
واش نتا من عشاق الشوكولا؟ 😍🍫
هاد الكريب غادي يعجبك بزاف!
```

Rejected as too formal:

```
يسرنا أن نقدم لكم فطيرة لذيذة ذات مذاق رائع
```

`ar` remains available for genuine MSA. `ary` and `ar` are separate languages
in the picker on purpose.

### Grounding

Every prompt carries hard rules, in every language:

- describe only what is visible — no invented ingredients, toppings or people;
- never invent a promotion, discount, price, opening time or award;
- never invent a location; mention one only when configured and requested;
- no health, nutrition or provenance claims.

A workspace can add its own bans in **Never claim**.

These are correctness rules, not style preferences: a caption promising a
discount that does not exist is a problem for the business, not a bad draft.

---

## Media analysis

**Images** are read from Storage with the admin SDK and passed to the model as
base64. No signed URL, no public object, nothing that outlives the request.

**Video** is decoded in the browser. Cloud Functions have no ffmpeg, and
shipping a whole video somewhere to read three frames would be slow and
expensive. `useVideoFrames.ts` seeks to three points — near the start, the
middle, near the end — captures each at 512px, and sends them as JPEGs. Three
frames is enough to tell preparation from a finished plate from a shot of the
room, which is the distinction the caption depends on.

Images are sent at `detail: low`, which identifies a dessert and its toppings
at a fraction of the cost of full detail.

---

## Cost control

| Control | Default | Where |
| --- | --- | --- |
| Per-workspace daily cap | 100 | `AI_QUOTA_PER_DAY` |
| Per-workspace hourly cap | 30 | `AI_QUOTA_PER_HOUR` |
| Video frames analysed | 3 | `AI_QUOTA_DEFAULTS.maxVideoFrames` |
| Largest image analysed | 4 MB | `AI_QUOTA_DEFAULTS.maxImageBytes` |
| Request timeout | 45 s | `OPENAI_TIMEOUT_MS` |
| Image detail | low | provider |

Quota is **reserved before the call, not recorded after it**: a request that
fails partway still consumed provider tokens, so it still has to count. The
check and the increment happen in one transaction, so two concurrent requests
cannot both claim the last unit.

Nothing regenerates on its own. Every model call is a button press.

Cost in money is reported only when `OPENAI_INPUT_USD_PER_MTOK` and
`OPENAI_OUTPUT_USD_PER_MTOK` are set. An invented figure is worse than none,
so the field stays null otherwise.

---

## Security

- The API key lives in Secret Manager and is bound to the AI callables only.
  Publishing code cannot read it.
- Every call is authenticated and requires `content.write` in that workspace;
  settings require `workspace.settings`.
- Media never becomes public. Images are read server-side; frames come from the
  browser that already had the file.
- `aiGenerations` is readable by members, writable only by the backend.
- `aiQuota` is closed to clients entirely — a client that could edit it could
  lift its own cap.
- Provider error bodies are not logged; they can echo request content.

## Firestore

```
workspaces/{w}/settings/aiContent      AiContentSettings
workspaces/{w}/aiGenerations/{id}      one row per model call
workspaces/{w}/aiQuota/counters        server-only spend counters
```

`aiGenerations` keeps the generated text and token usage, never secrets and
never the media. `accepted` records whether a suggestion was taken — the only
honest measure of whether the feature earns its cost.

---

## Configuration

Secret:

```bash
firebase functions:secrets:set OPENAI_API_KEY --project crepelite-social-hub
```

Non-secret, in `functions/.env.<project>`:

```
AI_PROVIDER=openai
OPENAI_MODEL=              # set this; the code default may be retired
OPENAI_TIMEOUT_MS=45000
OPENAI_INPUT_USD_PER_MTOK=
OPENAI_OUTPUT_USD_PER_MTOK=
AI_QUOTA_PER_DAY=100
AI_QUOTA_PER_HOUR=30
ENABLE_MOCK_AI=false       # must be false in production
```

> **Set `OPENAI_MODEL` explicitly.** The code ships a fallback so the build
> works, but vendors retire model names on their own schedule and a hardcoded
> one turns into an outage. Check the current lineup.

Per-workspace defaults live in **Settings → AI content** and are editable by
owners and admins: language, tone, emojis, hashtags, CTA, location, brand
context, always-include hashtags and forbidden claims. None of it is hardcoded.

---

## Tests

`tests/functions/aiCaption.test.ts`, entirely against `MockAIContentProvider`.
A real model is never called: it costs money, it is slow, and assertions
against it would be flaky by construction.

Covered: generation from an image, generation from video frames, three
suggestions in order, Darija as the default and Arabic script in the output,
the prompt naming the register and banning MSA, grounding rules in every
language, forbidden claims reaching the prompt, location suppression, platform
adaptation respecting each manifest's fields, rewrites, provider failure,
timeout, rate limit and unconfigured, registry behaviour including the mock
being unreachable in production, and that the generator exposes no publishing
surface at all.

The mock is switched between outcomes with `MockAIContentProvider.outcome`.
