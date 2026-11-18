# AgentQuote AI

Quote sourcing and comparison for C&F agents. Send one RFQ to many partner agents by email, let AI read their replies (email text, PDF, Excel, scans), compare like-for-like, add margin and send the customer a quotation.

## Stack
- Node 20 + Express, PostgreSQL, React (Vite)
- Email: SMTP send + IMAP receive, per configurable mailbox (Settings → RFQ mailboxes)
- AI: Anthropic API (key set in Settings → AI, or `ANTHROPIC_API_KEY`)

## Structure (shared engines, no duplicated logic)
- `server/engines/charges.js` – legs, charge codes, bases, normalisation (single source of truth)
- `server/engines/costing.js` – quantities, FX, comparison, customer quote maths
- `server/services/` – mail, replies (matching + AI pipeline), RFQ lifecycle, customer quote PDF, templates
- `client/src/components/` – reusable UI, shipment form, agent picker, quote editor

## Environment
| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection |
| `APP_SECRET` | Signs sessions and encrypts stored mailbox/AI passwords |
| `ANTHROPIC_API_KEY` | Optional; can be set in the app instead |
| `MAIL_POLL_SECONDS` | IMAP check interval (default 60) |
| `PLATFORM_ADMIN_EMAILS` | Comma-separated emails that see the Integrata admin console (tenants, plans) |
| `TRIAL_DAYS` | Free trial length for new sign-ups (default 14) |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Razorpay API keys for subscriptions |
| `RAZORPAY_WEBHOOK_SECRET` | Secret of the Razorpay webhook pointing to `/api/billing/razorpay/webhook` |

## Multi-tenancy
Each company (tenant) has its own Postgres schema (`t_<slug>`); platform tables (`tenants`, `plans`, `accounts`, `billing_events`) live in `public`.
Every request and background job runs inside its tenant's context (`runAsTenant`), with `search_path` set to that schema only.

## Run locally
```
npm install && npm run build
DATABASE_URL=postgres://... APP_SECRET=... npm start
npm test
```
First visit creates the admin account.
