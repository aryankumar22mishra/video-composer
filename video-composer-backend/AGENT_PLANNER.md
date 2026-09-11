# Video agent planner and executor

The editor sends natural-language goals to `POST /api/ai/plan/`. The text provider
plans registered tool calls; the browser validates and executes them against a
private composition. Each subsequent round receives the actual staged composition,
asset descriptors, selection, conversation and tool receipts, including newly
created clip, text and asset IDs. The text model does not generate media.

Run `python manage.py migrate` after updating. This adds the `AgentOperation`
receipt table without changing existing projects or render jobs. Existing
`AI_PROVIDER`, `AI_MODEL`, provider keys and base URL settings still configure
the planner. No new frontend credentials are required.

## Registry and execution

`../video-composer-frontend/src/agent/toolRegistry.json` is the central registry.
Each entry declares its name, description, argument schema, availability policy,
executor key and, for media services, configuration prefix and supported alternative.
The backend reads this same file and builds the planner definitions from it.
Keep both project directories together when deploying the backend, or include this
registry at the same relative path in your deployment artifact.

The browser binds executor keys to trusted functions in `src/agent/executors.js`.
Existing edits reuse `state/editingCommands.js`. Backend service executors live in
`composer/media_tools.py`. New tools require a registry entry and a matching trusted
executor; no model-generated JavaScript, Python, shell command or URL is executed.

Routes:

| Route | Purpose |
| --- | --- |
| `GET /api/ai/tools/?recording_state=idle` | Registry with current availability and exact missing configuration |
| `POST /api/ai/plan/` | One planning round, with staged context and actual tool results |
| `POST /api/ai/media/prepare/` | Prepare a specific service request; does not start a job |
| `POST /api/ai/media/execute/` | Execute a separately approved service operation |
| `POST /api/ai/` | Backward-compatible legacy action endpoint; current editor uses the planner |

Plans return `status`, `goal`, `message`, `calls`, the accumulated `brief`,
`goal_id`, `goal_kind`, and a structured `pending_clarification`. Status is `continue`, `done`,
`clarify` or `unavailable`. Only `continue` includes calls. A call contains `id`,
`name`, `arguments` and optional `depends_on` IDs. Dependencies must have succeeded
earlier or appear earlier in the same sequential batch. New result IDs must come
from a subsequent planning round; invented IDs and unresolved references fail.

For example, split a clip, receive the actual two new clip IDs, then trim or mute
one of those IDs in the next round. Calls are validated against the shared argument
schema on both sides and against actual composition state in the browser.

## Editing and creation workflow

- Single edits can commit directly after the planner receives their successful
  execution receipts and finishes the goal.
- Promotional goals maintain a brief with `subject`, `audience`, `key_message`,
  `duration_seconds` and `format`. Subject, audience and key message are essential;
  the agent asks for the next missing field one question at a time. Duration defaults
  to 30 seconds and format to the current canvas aspect ratio. Once essentials are
  known, `plan_scenes` proposes a concrete scene plan for approval.
- `append_asset` assembles uploaded or approved generated images/videos into
  normal editable clips. Text tools add overlays. `set_background_audio` uses an
  uploaded or generated audio asset as the editor's existing single background
  track. Multiple independently timed narration tracks are not implemented.
- `generate_image`, `generate_video`, `text_to_speech` and `transcribe` call separate
  configured services. Every service request requires explicit approval. Generated
  images, videos and audio must also pass browser decoding and user preview approval.
- Transcription returns actual text, available in the progress panel and subsequent
  planner context. This is distinct from the chat microphone's browser speech input.

Conversation state (goal ID, brief, recent messages and pending question) is separate
from the staged composition. Every `/api/ai/plan/` round receives that accumulated
context. Provider `brief_update` values merge into it; omitted, null and empty values
cannot erase earlier answers. Corrections update the relevant field, while a clearly
new creation request starts a fresh brief. Conversation updates are saved before
execution and survive clarification or editing rollback. A completed brief cannot
trigger another audience/subject question: the backend requests a scene-plan repair
once, then returns an explanation with the brief retained if the provider still fails.

Regression conversation:

1. ?Create a short promotional video.? ? ask for the subject.
2. ?AI video for college, 30 seconds.? ? retain the subject and 30-second duration;
   ask for the audience.
3. ?College students.? ? retain `audience="college students"` and
   `duration_seconds=30`; ask only ?What key message should college students take away??

Composition edits stay staged until the goal finishes, then enter history as one
undoable change. Failure, cancellation, a clarification or an unavailable capability
discards the entire staged composition. Generated service jobs are external effects:
discarding edits or undoing cannot cancel a submitted job or reverse its charges.
Generated files are retained on the backend even if the user declines their preview.
Approved assets committed to the browser library remain available for undo/redo.

Recording/upload UI actions are deferred until the plan finishes; receipts identify
them as queued until the UI handler runs. Opening Upload does not select a file, and
opening recording setup does not grant capture permissions or start recording.

Editor revisions include composition, media library, audio selection and clip/text
selection. Changes invalidate outstanding plans and pending approvals, including an
edit followed by undo. Only one browser request runs at a time. Repeated call IDs
reuse receipts; changing arguments under an old ID is rejected. Repeated identical
media calls within one goal reuse the approved result, even with another call ID.

Limits: 10 planning rounds, 6 calls per batch, 24 calls per goal, and 4 service
operations per goal. Planning overload retries are limited to one browser retry;
the existing provider transport has its bounded retries. Media jobs are never
automatically retried. A failure aborts execution and sends the failure receipt to
the planner for context without executing another plan. Narrow the goal to retry.

## Configuring media services

These are explicit **gateway adapters**, not native SDK integrations with a named
media vendor. Point each URL at your trusted HTTPS service implementing the contract
below. An ordinary text-model URL or a vendor endpoint with a different contract
will not work. Blank URL/key settings disable that capability and expose the exact
missing variable names plus an upload/manual alternative to the agent.

| Tool | Required backend variables |
| --- | --- |
| `transcribe` | `TRANSCRIPTION_SERVICE_URL`, `TRANSCRIPTION_API_KEY` |
| `text_to_speech` | `TTS_SERVICE_URL`, `TTS_API_KEY` |
| `generate_image` | `IMAGE_GENERATION_SERVICE_URL`, `IMAGE_GENERATION_API_KEY` |
| `generate_video` | `VIDEO_GENERATION_SERVICE_URL`, `VIDEO_GENERATION_API_KEY` |

Each prefix also accepts `_COST_NOTICE`, for example
`IMAGE_GENERATION_COST_NOTICE=Approximately 1 credit per image`. This is a configured
billing notice, not a live price quote. Without one, the UI explicitly states that
an exact price is not configured. Approval displays the tool, provider hostname,
exact arguments and notice; it authorizes only that specific operation.

The gateway receives HTTPS POST with `Authorization: Bearer <service key>` and
`Idempotency-Key: <operation UUID>` headers. Implement idempotency at the gateway too.
Requests use this JSON envelope:

```json
{
  "tool": "generate_image",
  "operation_id": "a UUID",
  "arguments": {"prompt": "Product photograph of coffee", "width": 1280, "height": 720}
}
```

Transcription additionally includes `media: {"mime_type":"audio/wav","base64":"..."}`.
Only transcription uploads source bytes, after explicit consent. Approval binds
the source file's SHA-256 digest, exact arguments, endpoint and operation identity.
The planner receives metadata and tool results, never source media bytes.

Successful gateway responses must be synchronous JSON:

- Transcription: `{"text":"Actual transcript"}` (at most 20,000 characters).
- Generation/speech: `{"mime_type":"image/png","base64":"encoded media bytes"}`.
  Supported types: PNG/JPEG/WebP images, MP4/WebM video, MP3/WAV/Ogg audio.

The gateway must finish within 60 seconds; adapt longer asynchronous vendor jobs
inside the gateway or add a dedicated polling adapter before enabling those vendors.
Source transcription uploads are limited to 20 MB; generated files to 50 MB.
Redirects and provider-supplied asset download URLs are not accepted. Generated
bytes are stored beneath `media/agent/generated/` and decoded in the browser before
review. Credentials stay in the Django environment and are never returned to the UI.

Preparation produces a signed approval token valid for 15 minutes. Execution uses
a durable database receipt and an atomic state transition so duplicate requests
cannot submit the same operation twice. A timeout, invalid response or ambiguous
failure marks it `uncertain`; the same operation cannot be resubmitted automatically.
Inspect the service account using its operation UUID before authorizing another job.
The receipt table is application state, not a replacement for API authentication;
the existing development backend's access policy remains unchanged.

## Verification

```powershell
# Frontend
npm test
npm run lint
npm run build

# Backend, from its activated environment
python manage.py test
python manage.py makemigrations --check --dry-run
```

Tests cover registry/executor agreement, schema validation, single edits, dependent
calls with actual IDs, promotional scene planning and assembly, one-step undo/redo,
stale/duplicate/cancelled requests, budgets, unavailable services, paid confirmation,
preview rejection, durable service receipts and failure after earlier edits succeed.
Provider and media services are mocked; these checks do not spend API credits.

Manual checks with configured services: ask for a promotion without details; answer
the focused question; approve its scene plan; inspect each paid request and generated
preview; verify clips remain editable; undo/redo the assembly; then preview/export
using the existing browser pipeline. Also reject a preview or change the composition
while a request is pending and verify no staged edits are committed.
