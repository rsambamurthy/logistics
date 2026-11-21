-- Incremental migrations (idempotent). Runs after schema.sql on every start.

-- 1. One party list: the "agents" table holds every company, flagged as partner agent and/or customer.
ALTER TABLE agents ALTER COLUMN email DROP NOT NULL;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_agent BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_customer BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS currency TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS margin_pct NUMERIC;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS tax_pct NUMERIC;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS party_id INT REFERENCES agents(id);

-- 2. RFQ requester (customer or partner agent) and link to the enquiry email.
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS requester_id INT REFERENCES agents(id);
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS requester_role TEXT NOT NULL DEFAULT 'customer';
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS requester_ref TEXT;
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS source_email_id INT REFERENCES emails(id) ON DELETE SET NULL;

-- 3. Move legacy customers into the party list once.
DO $$
DECLARE c RECORD; pid INT;
BEGIN
  FOR c IN SELECT * FROM customers WHERE party_id IS NULL LOOP
    SELECT id INTO pid FROM agents WHERE c.email IS NOT NULL AND lower(email) = lower(c.email) LIMIT 1;
    IF pid IS NULL THEN
      INSERT INTO agents(company, contact, email, country, currency, margin_pct, is_agent, is_customer, source)
      VALUES (c.name, c.contact, c.email, c.country, c.currency, c.margin_pct, false, true, 'migrated')
      RETURNING id INTO pid;
    ELSE
      UPDATE agents SET is_customer = true, currency = coalesce(currency, c.currency), margin_pct = coalesce(margin_pct, c.margin_pct) WHERE id = pid;
    END IF;
    UPDATE customers SET party_id = pid WHERE id = c.id;
  END LOOP;
END $$;
UPDATE rfqs r SET requester_id = c.party_id FROM customers c WHERE r.customer_id = c.id AND r.requester_id IS NULL;

-- 4. Rate cards: stored buy rates (own or from a vendor) per leg and lane.
CREATE TABLE IF NOT EXISTS rate_cards (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  vendor_id INT REFERENCES agents(id),
  leg TEXT NOT NULL,
  mode TEXT,
  origin TEXT,
  destination TEXT,
  carrier TEXT,
  valid_from DATE,
  valid_to DATE,
  transit_days INT,
  free_days INT,
  notes TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rate_card_lines (
  id SERIAL PRIMARY KEY,
  rate_card_id INT NOT NULL REFERENCES rate_cards(id) ON DELETE CASCADE,
  charge_code TEXT NOT NULL,
  description TEXT,
  basis TEXT NOT NULL,
  rate NUMERIC NOT NULL,
  currency TEXT NOT NULL,
  equipment TEXT,
  qty_from NUMERIC,
  qty_to NUMERIC,
  min_amount NUMERIC,
  sort INT DEFAULT 0
);
ALTER TABLE rfq_invites ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'email';
ALTER TABLE agent_quotes ADD COLUMN IF NOT EXISTS rate_card_ids INT[];

-- 5. Quote follow-up and outcome
ALTER TABLE customer_quotes ADD COLUMN IF NOT EXISTS lost_reason TEXT;
ALTER TABLE customer_quotes ADD COLUMN IF NOT EXISTS lost_note TEXT;
ALTER TABLE customer_quotes ADD COLUMN IF NOT EXISTS competitor_price NUMERIC;
ALTER TABLE customer_quotes ADD COLUMN IF NOT EXISTS followup_count INT NOT NULL DEFAULT 0;
ALTER TABLE customer_quotes ADD COLUMN IF NOT EXISTS last_followup_at TIMESTAMPTZ;
ALTER TABLE customer_quotes ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;

-- 6. Linked RFQs (e.g. sea vs air alternatives), quote options, revisions, approvals
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS parent_rfq_id INT REFERENCES rfqs(id) ON DELETE SET NULL;
ALTER TABLE customer_quotes ADD COLUMN IF NOT EXISTS previous_id INT REFERENCES customer_quotes(id) ON DELETE SET NULL;
ALTER TABLE customer_quotes ADD COLUMN IF NOT EXISTS accepted_option INT;
ALTER TABLE customer_quotes ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'not_needed';
ALTER TABLE customer_quotes ADD COLUMN IF NOT EXISTS approval_requested_by INT;
ALTER TABLE customer_quotes ADD COLUMN IF NOT EXISTS approved_by INT;
ALTER TABLE customer_quotes ADD COLUMN IF NOT EXISTS approval_note TEXT;
ALTER TABLE customer_quotes ADD COLUMN IF NOT EXISTS created_by INT;

-- 7. Cargo details
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS hs_code TEXT;
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS dangerous_goods BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS dg_class TEXT;
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS un_number TEXT;
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS reefer_temp TEXT;
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS dimensions TEXT;
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS cargo_value NUMERIC;
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS cargo_value_currency TEXT;
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS stackable BOOLEAN;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS quote_language TEXT;

-- 8. Rate memory: rate cards created automatically from checked agent quotes
ALTER TABLE rate_cards ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE rate_cards ADD COLUMN IF NOT EXISTS source_quote_id INT;

-- 9. Email verification (existing users count as verified)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name='users' AND column_name='email_verified_at') THEN
    ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;
    UPDATE users SET email_verified_at = now();
  END IF;
END $$;

-- 10. Audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id INT,
  user_name TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INT,
  rfq_id INT,
  summary TEXT,
  details JSONB,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS audit_log_rfq ON audit_log(rfq_id);

-- 11. Booking stage: jobs, bookings, job costs, job files
CREATE TABLE IF NOT EXISTS jobs (
  id SERIAL PRIMARY KEY,
  ref TEXT UNIQUE NOT NULL,
  rfq_id INT REFERENCES rfqs(id) ON DELETE SET NULL,
  customer_quote_id INT REFERENCES customer_quotes(id) ON DELETE SET NULL,
  option_index INT DEFAULT 0,
  requester_id INT REFERENCES agents(id),
  status TEXT NOT NULL DEFAULT 'open',          -- open | booking_requested | booked | departed | arrived | completed | cancelled
  shipper JSONB DEFAULT '{}',
  consignee JSONB DEFAULT '{}',
  notify_party JSONB DEFAULT '{}',
  cargo_ready_date DATE,
  customer_ref TEXT,
  sell_currency TEXT,
  atd DATE, ata DATE,
  notes TEXT,
  created_by INT,
  created_at TIMESTAMPTZ DEFAULT now(),
  closed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS bookings (
  id SERIAL PRIMARY KEY,
  job_id INT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  invite_id INT REFERENCES rfq_invites(id) ON DELETE SET NULL,
  agent_id INT REFERENCES agents(id),
  tag TEXT NOT NULL,
  legs TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',         -- draft | requested | confirmed | rejected | cancelled
  message_id TEXT,
  requested_at TIMESTAMPTZ,
  carrier TEXT, booking_no TEXT, vessel TEXT, voyage TEXT, flight_no TEXT, mbl_awb TEXT,
  pol TEXT, pod TEXT,
  etd DATE, eta DATE,
  cutoffs JSONB DEFAULT '{}',                   -- { si, vgm, gate_in, docs, customs } 'YYYY-MM-DDTHH:MM' local port time
  empty_pickup TEXT,
  container_nos TEXT[] DEFAULT '{}',
  remarks TEXT,
  confidence NUMERIC,
  verified BOOLEAN DEFAULT false,
  source TEXT,
  confirmed_at TIMESTAMPTZ,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS job_costs (
  id SERIAL PRIMARY KEY,
  job_id INT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                           -- buy | sell
  leg TEXT,
  description TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  currency TEXT NOT NULL,
  agent_id INT REFERENCES agents(id),
  source TEXT NOT NULL DEFAULT 'manual',        -- quote | manual
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS job_files (
  id SERIAL PRIMARY KEY,
  job_id INT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind TEXT,                                    -- invoice | packing_list | si | other
  filename TEXT, content_type TEXT, size INT,
  data BYTEA,
  email_id INT,
  uploaded_by INT,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE emails ADD COLUMN IF NOT EXISTS job_id INT;
ALTER TABLE emails ADD COLUMN IF NOT EXISTS booking_id INT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS job_id INT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS customer_notified_at TIMESTAMPTZ;

-- 12. Documents: shipping instructions, draft / final BL-AWB, checklist
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS doc_waived TEXT[] DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS doc_extra TEXT[] DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS docs_requested_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS bl_no TEXT;
CREATE TABLE IF NOT EXISTS shipping_instructions (
  id SERIAL PRIMARY KEY,
  job_id INT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  booking_id INT REFERENCES bookings(id) ON DELETE SET NULL,
  data JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',          -- draft | sent | amended (changed after sending)
  source TEXT DEFAULT 'manual',                  -- manual | ai
  sent_at TIMESTAMPTZ,
  sent_count INT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bl_drafts (
  id SERIAL PRIMARY KEY,
  job_id INT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  booking_id INT REFERENCES bookings(id) ON DELETE SET NULL,
  is_final BOOLEAN NOT NULL DEFAULT false,
  version INT NOT NULL DEFAULT 1,
  file_id INT REFERENCES job_files(id) ON DELETE SET NULL,
  email_id INT,
  extracted JSONB DEFAULT '{}',
  discrepancies JSONB DEFAULT '[]',
  confidence NUMERIC,
  status TEXT NOT NULL DEFAULT 'received',       -- received | with_customer | customer_approved | customer_corrections | approved | corrections_sent | final
  customer_note TEXT,
  customer_email_id INT,
  sent_to_customer_at TIMESTAMPTZ,
  agent_reply_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 13. Tracking: provider snapshots, events, public link, milestone emails
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS track_token TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS track_enabled BOOLEAN DEFAULT true;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS notify_agents BOOLEAN DEFAULT false;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_notified JSONB DEFAULT '{}';
CREATE UNIQUE INDEX IF NOT EXISTS jobs_track_token ON jobs(track_token);
CREATE TABLE IF NOT EXISTS tracking (
  id SERIAL PRIMARY KEY,
  job_id INT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  booking_id INT REFERENCES bookings(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  mode TEXT NOT NULL,                            -- sea | air
  number TEXT NOT NULL,
  number_type TEXT,                              -- BL | BK | CT | AWB
  active BOOLEAN DEFAULT true,
  status TEXT,                                   -- provider status normalised: booked | in_transit | arrived | delivered | unknown
  snapshot JSONB DEFAULT '{}',                   -- normalised: pol/pod, etd/eta (estimated/actual), vessel, voyage, flight, position, carrier
  last_polled_at TIMESTAMPTZ,
  next_poll_at TIMESTAMPTZ DEFAULT now(),
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (job_id, number)
);
CREATE TABLE IF NOT EXISTS tracking_events (
  id SERIAL PRIMARY KEY,
  job_id INT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  tracking_id INT REFERENCES tracking(id) ON DELETE CASCADE,
  code TEXT,                                     -- normalised: gate_in | loaded | departed | transshipment | arrived | discharged | picked_up | delivered | other
  description TEXT,
  location TEXT,
  at TEXT,                                       -- local time as reported ('YYYY-MM-DD HH:MM')
  actual BOOLEAN DEFAULT true,
  container TEXT,
  vessel TEXT, voyage TEXT,
  source TEXT DEFAULT 'provider',                -- provider | manual
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tracking_events_once ON tracking_events(tracking_id, code, coalesce(at,''), coalesce(location,''), coalesce(container,''));

-- 14. Sign-out ends the session: tokens carry the user's session epoch
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_epoch INT NOT NULL DEFAULT 0;

-- 15. Admins can disable users (kept for history, cannot sign in, do not count as a seat)
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_by TEXT;

-- 16. Roles and permissions; record owners for "own records only" roles
CREATE TABLE IF NOT EXISTS roles (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  permissions TEXT[] NOT NULL DEFAULT '{}',
  system BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS assigned_to INT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS assigned_to INT;

-- 17. A user can hold several roles (permissions = all of them together), as in VendorGate
CREATE TABLE IF NOT EXISTS user_roles (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_key TEXT NOT NULL,
  PRIMARY KEY (user_id, role_key)
);
INSERT INTO user_roles(user_id, role_key) SELECT u.id, u.role FROM users u WHERE u.role IS NOT NULL AND NOT EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id=u.id);
-- the approval level a pending quotation waits on (approval authority comes from roles, not permissions)
ALTER TABLE customer_quotes ADD COLUMN IF NOT EXISTS approval_role TEXT;

-- 18. Rate sheets arriving by email: AI-read rate cards waiting for review
ALTER TABLE emails ADD COLUMN IF NOT EXISTS rate_proposal JSONB;
CREATE INDEX IF NOT EXISTS emails_parse_status_idx ON emails(parse_status);

-- 19. Package type on rate card charges and on the shipment (per-package pricing)
ALTER TABLE rate_card_lines ADD COLUMN IF NOT EXISTS package_type TEXT;
ALTER TABLE rfqs ADD COLUMN IF NOT EXISTS package_type TEXT;

-- 20. Consolidation: consols (masters) holding several jobs (houses); pieces with dimensions
CREATE TABLE IF NOT EXISTS consols (
  id SERIAL PRIMARY KEY,
  ref TEXT UNIQUE NOT NULL,
  mode TEXT NOT NULL,                              -- AIR | LCL
  origin TEXT, destination TEXT,
  carrier TEXT, flight_no TEXT, vessel TEXT, voyage TEXT,
  etd DATE, eta DATE, cutoff TIMESTAMPTZ,
  mawb TEXT,                                       -- master AWB (air) / master BL (sea)
  container_type TEXT,
  agent_id INT REFERENCES agents(id) ON DELETE SET NULL,
  buy_currency TEXT, buy_rate NUMERIC, buy_min NUMERIC, buy_fixed NUMERIC,
  capacity_kg NUMERIC,
  status TEXT NOT NULL DEFAULT 'planning',         -- planning | closed | departed | arrived | cancelled
  notes TEXT,
  created_by INT,
  created_at TIMESTAMPTZ DEFAULT now(),
  closed_at TIMESTAMPTZ
);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS consol_id INT REFERENCES consols(id) ON DELETE SET NULL;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS hawb TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pieces JSONB;
CREATE INDEX IF NOT EXISTS jobs_consol_idx ON jobs(consol_id);

-- 21. Agent invoices checked against quoted / booked costs (cost-leakage check)
ALTER TABLE job_costs ADD COLUMN IF NOT EXISTS charge_code TEXT;
CREATE TABLE IF NOT EXISTS agent_invoices (
  id SERIAL PRIMARY KEY,
  job_id INT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  agent_id INT REFERENCES agents(id) ON DELETE SET NULL,
  file_id INT REFERENCES job_files(id) ON DELETE SET NULL,
  attachment_id INT REFERENCES attachments(id) ON DELETE SET NULL,
  email_id INT,
  invoice_no TEXT, invoice_date DATE, currency TEXT, total NUMERIC, tax NUMERIC, refs TEXT, supplier TEXT,
  lines JSONB, result JSONB, leakage NUMERIC,
  status TEXT NOT NULL DEFAULT 'to_check',          -- to_check | ok | disputed | approved
  note TEXT,
  created_by INT, created_at TIMESTAMPTZ DEFAULT now(),
  decided_by INT, decided_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS agent_invoices_job_idx ON agent_invoices(job_id);

-- 22. Delay prediction: first ETA seen (to learn punctuality) and the latest assessment
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS first_eta TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS delay_risk JSONB;
