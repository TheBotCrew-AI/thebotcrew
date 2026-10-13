# Follow-up SOP — turning the stage playbook on for a tenant

> The operator's checklist for the per-stage follow-up system (0067–0070). Do this per
> tenant, then per service. The *why* lives in `business-logic.md` §4.4–§4.7; this file
> is only *what to do*, in order, with the SQL. If a step here contradicts the code, the
> code wins — fix this file in the same change.

## What the system does, in one paragraph

Every answered turn stamps the lead's **stage** on the conversation: NI (only the ad's
opener), I (saw the price), A (asked about their case), C (asked for slots or said yes). When
the lead goes quiet, the ladder fires the stage's **sequence**: an ordered story of steps,
each with a **cover mark** (`precio`, `quien`, `que-esperar`, `prueba`, `oferta`, `duda`,
`cierre`). Rung N sends the first step the conversation has not covered yet; the model only
writes the step's text. A step can **deliver a file** (price sheet, what-to-expect PDF,
before/after, the clinic) from `media_assets`. Facts come from `services[].description`.
Nothing of this is tenant text: the platform preset `medicina-estetica` carries the arc.

## Part A — per tenant (once)

Do these in order. Each has a check you can run.

### A1. The switch: `follow_up_cadence`

No cadence = no rounds = no nudges, playbook or not. The playbook reshapes **round 0 only**;
rounds 1+ keep the platform taper (`follow_up_rounds`, NULL = platform default).

```sql
update tenant_config set follow_up_cadence = '{30,360,720,1200}' where business_name = '<name>';
```

(The preset's per-stage cadences override this for round 0, so the value matters only for a
stage the playbook leaves out, and as the on/off switch.)

### A2. Interest tags ON — mandatory for the playbook

The classifier only persists `conversations.interest` (which service the lead asked about)
when `interest_tags = true`. Without it the nudge has **no service facts** ("Lo que le
interesa" is empty, every step says "no afirmes nada") and the `byInterest` overrides never
apply.

```sql
update tenant_config set interest_tags = true where business_name = '<name>';
```

Check after a few conversations: `select interest, count(*) from conversations where
client_id = '<client_id>' group by 1;` — mostly non-null.

### A3. Quiet hours and timezone

Nudges are pushed out of `quiet_hours` (NULL = 21:00–08:00 local) at **send time**, in
`tenant_config.timezone`. A wrong timezone shifts every rung. Verify
`select timezone, quiet_hours from tenant_config where …`.

### A4. The playbook: the preset

```sql
update tenant_config set follow_up_playbook = '{"preset": "medicina-estetica"}'::jsonb
where business_name = '<name>';
```

That is a complete playbook. The arc it runs (cadence in minutes after silence, round 0):

| Stage | Cadence | Steps in order |
|---|---|---|
| NI | 10, 60, 240, 1200 | `precio` (file `precios`) → `quien` (file `consultorio`) → `que-esperar` (file `que-esperar`) → `oferta` |
| I | 20, 180, 600, 1320 | `quien` → `que-esperar` → `prueba` (file `antes-despues`) → `oferta` |
| A | 15, 120, 480, 1200 | `que-esperar` → `prueba` → `oferta` → `cierre` |
| C | 10, 60, 300, 1080 | `cierre` → `duda` → `cierre` → `cierre` |

Rules you must know when reading a thread:

- **Marks are per conversation.** A lead who got `precio` at NI and rises to I gets `quien`
  next, never the price again. `precio` also counts as covered when any bot message already
  stated a `$` amount (the front-desk reply usually does).
- **A step with a missing file goes out as text**, except `prueba`, which is **skipped**
  (no before/after = no "trust me" message).
- **`cierre` is the only repeatable step.** When every other mark is covered the model
  free-forms under the stage's objective.
- **The last rung of the last round is the farewell**, playbook or not (teaches `CITA`).
- Files only go out on channels that carry them: WhatsApp image + PDF, Facebook image + PDF,
  Instagram image only. A PDF step on Instagram goes out as text (or is skipped, if `prueba`).

### A5. Overrides (only when the clinic has a line the preset can't say)

The preset says "el médico", not a name, and promises nothing clinic-specific. Add an
override **per stage and treatment** when a treatment has a real hook — a same-day
application, a price-if-you-start-within-N-days, a free evaluation that isn't in the
description. An override replaces that stage's **whole sequence** for that treatment; the
preset's cadence and objective ride along.

```json
{ "preset": "medicina-estetica",
  "byInterest": {
    "<services[].name, exact>": {
      "I": { "sequence": [
        { "covers": "quien",       "asset": "consultorio",   "text": "…" },
        { "covers": "que-esperar", "asset": "que-esperar",   "text": "…" },
        { "covers": "prueba",      "asset": "antes-despues", "text": "…" },
        { "covers": "oferta",                                "text": "…" } ] } } } }
```

- The `byInterest` key must equal `services[].name` (accent- and case-tolerant, but spell it
  the same). A key that matches no service is dead config.
- `text` is a **directive**, not copy. Facts must be in the description or named in the
  directive — the model has no tools and may state nothing else.
- **Vary the silhouette.** The prompt already caps a nudge at 160 characters, one question, no
  reaction, no "Qué bueno que…"; what the directive decides is the shape. Write some steps as
  "SOLO la pregunta: …" and others as "<dato>, en media línea; y pregunta …". Four steps of
  "di en una línea X y pregunta Y" come out as four identical messages, and that is what reads
  as a bot whatever the words. Say what NOT to add ("sin explicar el tratamiento", "sin el
  precio normal") — the model pads otherwise.
- Keep the four-step shape and the marks; reorder only after reading the outcomes view (A8).
- Reference: `docs/playbooks/heriberto-follow-up-playbook.sql` (láser I, bótox A).

### A6. Test on your own thread before traffic

With `test_contact_ids` set (or on a live tenant, your own contact): send the ad opener,
stay silent, and move the first rung forward instead of waiting:

```sql
update follow_ups set scheduled_for = now() where conversation_id = '<conversation uuid>' and status = 'pending';
```

Then read what went out:

```sql
select metadata->>'stage' stage, metadata->>'step' step, metadata->>'asset' asset, metadata->>'preset' preset, created_at
from bot_events where conversation_id = '<conversation uuid>' and event_type = 'follow_up_sent' order by created_at;
```

Expect: NI thread → `precio` first (text until the file exists). Reply once mid-ladder,
go quiet again → the next nudge continues the story, repeats nothing.

### A7. Stage sanity after a day of traffic

```sql
select stage, status, conversations from stage_at_silence where client_id = '<client_id>' order by 1, 2;
```

Most ad leads are NI; a tenant with everyone in C has a floor problem, not a lead problem
(report it). Reset of a test thread: delete its `follow_ups`, `bot_events`, `messages`,
`conversations` rows as in the tenant's memory note.

### A8. The metric — one week, then decide

```sql
select stage, step, sent, replied, round(100.0 * replied / nullif(sent, 0), 1) as reply_pct
from follow_up_step_outcomes where client_id = '<client_id>' order by stage, reply_pct desc;
```

`replied` = the lead wrote back before the next rung. Reorder or rewrite a step only on
this number, never on one thread.

## Part B — per service

For every entry of `services[]` the tenant sells through ads:

### B1. The description IS the script

`services[].description` is the only business fact a nudge may state. Write it as the
sentences the nudge should be able to say, in this order: **price (with unit: por zona /
por sesión / por vial), what it includes, what it does, what to expect (sessions, recovery,
when results show), whether the evaluation is free and what it costs if not.** No marketing
fluff, no history, no "antes costaba". Example that works:

> Precio normal $4,500 por sesión; precio especial de $3,500 por sesión en todo el
> tratamiento si lo inicia dentro de los 14 días siguientes a su evaluación médica (sin
> costo). Mejora textura, poros, manchas y cicatrices. Requiere evaluación médica previa y
> contempla tiempo de recuperación.

A service with no price in the description makes the NI `precio` step say "what it
includes" — fine if that is the intent, a bug if the price exists and isn't there.

### B2. Files, per slot — upload to the GHL Media Library, then one row each

Slots the preset uses and what to ask the clinic for:

| Slot | What it is | Kind | Per treatment? |
|---|---|---|---|
| `precios` | the price sheet (one image; WhatsApp shows it inline) | image | yes, or one generic sheet (`interest` NULL) |
| `que-esperar` | one page: qué se siente, cuánto dura, cuidados | document or image | yes |
| `antes-despues` | a real case, consented, no faces if the clinic prefers | image | yes — **without it `prueba` is skipped** |
| `consultorio` | the clinic / the doctor at work | image | no (generic) |
| `testimonio` | not used by the preset yet; keep it for an override | image/document | — |

```sql
insert into media_assets (client_id, slot, kind, url, name, interest) values
  ('<client_id>', 'precios',       'image',    'https://assets.cdn.filesafe.space/<loc>/media/<id>.png', 'precios-botox.png',      'Botox'),
  ('<client_id>', 'que-esperar',   'document', 'https://assets.cdn.filesafe.space/<loc>/media/<id>.pdf', 'que-esperar-botox.pdf',  'Botox'),
  ('<client_id>', 'antes-despues', 'image',    'https://assets.cdn.filesafe.space/<loc>/media/<id>.jpg', 'antes-despues-botox.jpg','Botox'),
  ('<client_id>', 'consultorio',   'image',    'https://assets.cdn.filesafe.space/<loc>/media/<id>.jpg', 'consultorio.jpg',        null);
```

- `interest` must equal `services[].name`; a treatment row wins over the NULL row.
- `name` is the filename the lead sees — make it readable.
- URL must be public and **direct** (no redirect). The GHL Media Library is the easy host.
- Replace: `update … set url = …, name = … where client_id = … and slot = … and interest is not distinct from …`.
  Retire: `active = false`. Never delete (the URL is in `messages.attachments` history).
- Until the rows exist the steps run as text; the day a row lands the file starts going out.
  No playbook edit, no deploy.

### B3. One override if the treatment has a hook (A5), else nothing

## Part C — the order when SHIPPING code around this

Expand/contract, as always: migration first (every 0067–0070 migration is backward-compatible
with the previous Worker), Worker second, **tenant playbook JSON last** — a Worker that
doesn't know `preset`/`sequence` ignores them and runs the flat ladder. After any deploy,
`curl <workers.dev>/p/x` must say "Esta liga no existe".

## Part D — the checklist

Per tenant:
- [ ] `follow_up_cadence` set
- [ ] `interest_tags = true`
- [ ] `timezone` + `quiet_hours` verified
- [ ] `follow_up_playbook = {"preset": "medicina-estetica"}` (+ overrides only with a real hook)
- [ ] own-thread test: `follow_up_sent` events show `step` and `preset`
- [ ] after a day: `stage_at_silence` looks sane
- [ ] after a week: `follow_up_step_outcomes` read before any reorder

Per service:
- [ ] `description` rewritten as the script (price with unit → includes → what it does → what to expect → evaluation cost)
- [ ] `precios`, `que-esperar`, `antes-despues` rows (treatment-specific)
- [ ] `consultorio` row (generic, once per tenant)
- [ ] `byInterest` override only if the treatment has a hook the preset can't say

## Live tenants on the playbook

| Tenant | Since | Playbook | Files |
|---|---|---|---|
| Dr. Heriberto Valdivia | 2026-10-12 | preset + láser I + bótox A (v4, short-form) | none yet (sample rows inactive) |
