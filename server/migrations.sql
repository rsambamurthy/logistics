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
