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
