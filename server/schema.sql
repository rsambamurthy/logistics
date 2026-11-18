-- AgentQuote AI schema (idempotent)
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS mailboxes (
  id SERIAL PRIMARY KEY,
  label TEXT NOT NULL,
  from_name TEXT NOT NULL,
  from_email TEXT NOT NULL,
  reply_to TEXT,
  cc TEXT,
  bcc TEXT,
  signature TEXT,
  subject_template TEXT NOT NULL DEFAULT 'Rate request {{route}} {{tag}}',
  reminder_hours INT NOT NULL DEFAULT 24,
  max_reminders INT NOT NULL DEFAULT 2,
  smtp_host TEXT, smtp_port INT DEFAULT 587, smtp_secure BOOLEAN DEFAULT false,
  smtp_user TEXT, smtp_pass_enc TEXT,
  imap_host TEXT, imap_port INT DEFAULT 993, imap_secure BOOLEAN DEFAULT true,
  imap_user TEXT, imap_pass_enc TEXT, imap_folder TEXT DEFAULT 'INBOX',
  last_uid INT DEFAULT 0,
  last_poll_at TIMESTAMPTZ,
  last_poll_error TEXT,
  is_default BOOLEAN DEFAULT false,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  contact TEXT,
  email TEXT,
  country TEXT,
  currency TEXT DEFAULT 'INR',
  margin_pct NUMERIC,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agents (
  id SERIAL PRIMARY KEY,
  company TEXT NOT NULL,
  contact TEXT,
  email TEXT NOT NULL,
  cc TEXT,
  country TEXT,
  city TEXT,
  agent_type TEXT,
  services TEXT[] DEFAULT '{}',
  ports TEXT,
  notes TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rfqs (
  id SERIAL PRIMARY KEY,
  ref TEXT UNIQUE NOT NULL,
  customer_id INT REFERENCES customers(id),
  mailbox_id INT REFERENCES mailboxes(id),
  mode TEXT NOT NULL,
  pol TEXT, pod TEXT,
  pickup_place TEXT, delivery_place TEXT,
  incoterm TEXT,
  commodity TEXT,
  containers JSONB DEFAULT '[]',
  packages INT, gross_weight_kg NUMERIC, volume_cbm NUMERIC,
  ready_date DATE,
  deadline TIMESTAMPTZ,
  notes TEXT,
  legs TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rfq_invites (
  id SERIAL PRIMARY KEY,
  rfq_id INT NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  agent_id INT NOT NULL REFERENCES agents(id),
  tag TEXT NOT NULL,
  legs TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  message_id TEXT,
  sent_at TIMESTAMPTZ, replied_at TIMESTAMPTZ, last_reminder_at TIMESTAMPTZ,
  reminder_count INT DEFAULT 0,
  awarded BOOLEAN DEFAULT false,
  last_error TEXT,
  UNIQUE (rfq_id, agent_id)
);

CREATE TABLE IF NOT EXISTS emails (
  id SERIAL PRIMARY KEY,
  direction TEXT NOT NULL,
  kind TEXT,
  mailbox_id INT REFERENCES mailboxes(id),
  rfq_id INT REFERENCES rfqs(id) ON DELETE CASCADE,
  invite_id INT REFERENCES rfq_invites(id) ON DELETE CASCADE,
  message_id TEXT,
  in_reply_to TEXT,
  from_addr TEXT, to_addr TEXT, cc_addr TEXT,
  subject TEXT,
  body_text TEXT,
  body_html TEXT,
  at TIMESTAMPTZ DEFAULT now(),
  parse_status TEXT,
  parse_error TEXT
);
CREATE INDEX IF NOT EXISTS emails_msgid ON emails(message_id);

CREATE TABLE IF NOT EXISTS attachments (
  id SERIAL PRIMARY KEY,
  email_id INT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  filename TEXT, content_type TEXT, size INT,
  data BYTEA
);

CREATE TABLE IF NOT EXISTS agent_quotes (
  id SERIAL PRIMARY KEY,
  rfq_id INT NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  invite_id INT NOT NULL REFERENCES rfq_invites(id) ON DELETE CASCADE,
  email_id INT REFERENCES emails(id) ON DELETE SET NULL,
  valid_until DATE,
  transit_days INT,
  free_days INT,
  routing TEXT,
  carrier TEXT,
  remarks TEXT,
  exclusions TEXT,
  declined BOOLEAN DEFAULT false,
  confidence NUMERIC,
  verified BOOLEAN DEFAULT false,
  source TEXT DEFAULT 'ai',
  superseded BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quote_lines (
  id SERIAL PRIMARY KEY,
  agent_quote_id INT NOT NULL REFERENCES agent_quotes(id) ON DELETE CASCADE,
  leg TEXT NOT NULL,
  charge_code TEXT NOT NULL,
  description TEXT,
  basis TEXT NOT NULL DEFAULT 'per_shipment',
  rate NUMERIC NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  qty NUMERIC,
  confidence NUMERIC,
  sort INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS customer_quotes (
  id SERIAL PRIMARY KEY,
  rfq_id INT NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  currency TEXT NOT NULL,
  selection JSONB NOT NULL,
  margin_pct NUMERIC NOT NULL DEFAULT 0,
  tax_pct NUMERIC NOT NULL DEFAULT 0,
  language TEXT DEFAULT 'en',
  valid_until DATE,
  terms TEXT,
  snapshot JSONB,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT now(),
  sent_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ
);
