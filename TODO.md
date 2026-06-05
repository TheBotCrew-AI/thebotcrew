# TODO

## Infra / Deploy
- [ ] Add a custom domain to the Worker (replace `workers.dev` URL) — add `"routes"` to `wrangler.jsonc` and redeploy
- [ ] Set up a staging environment (separate Worker name + secrets)

## GHL Integration
- [ ] Confirm outbound message endpoint (`POST /conversations/messages`) + auth header → wire `GhlClient.sendMessage()`
- [ ] Confirm webhook signature scheme (which header, HMAC vs shared secret) → replace placeholder in `verifyWebhook()`
- [x] Resolve auth model: per-location OAuth via GHL App Marketplace → `ghl_oauth_tokens` table, install at `/oauth/ghl/install`
- [ ] Wire calendar availability (`GhlClient.getAvailability()`)
- [ ] Wire appointment booking (`GhlClient.bookAppointment()`)

## Agent / Roles
- [ ] Run evals against remote DB (`pnpm eval`) and review results
- [ ] Tune front-desk prompt with a real tenant's data (replace demo config)
- [ ] Add anti-hallucination eval cases

## Onboarding
- [ ] Seed first real tenant into remote Supabase (`tenants` + `tenant_config` rows)
- [ ] Point that tenant's GHL subaccount webhook at the Worker URL
- [ ] Smoke test with `webhook:simulate` against real `locationId`
