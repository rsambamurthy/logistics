-- Platform (control plane) tables in the public schema. Idempotent.
CREATE TABLE IF NOT EXISTS plans (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_inr NUMERIC NOT NULL DEFAULT 0,      -- per user per month
  price_hkd NUMERIC NOT NULL DEFAULT 0,      -- shown to Hong Kong tenants (charged in INR by Razorpay)
  max_users INT,                             -- NULL = unlimited
  max_rfqs_month INT,                        -- NULL = unlimited
  ai_enabled BOOLEAN NOT NULL DEFAULT true,
  razorpay_plan_id TEXT,
  sort INT DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true
);
INSERT INTO plans(code,name,price_inr,price_hkd,max_users,max_rfqs_month,ai_enabled,sort) VALUES
  ('starter','Starter',1499,149,2,100,true,1),
  ('growth','Growth',2499,249,10,1000,true,2),
  ('pro','Pro',3999,399,NULL,NULL,true,3)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS tenants (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  schema TEXT UNIQUE NOT NULL,
  country TEXT,
  billing_email TEXT,
  status TEXT NOT NULL DEFAULT 'trialing',   -- trialing | active | past_due | suspended | cancelled
  plan_code TEXT REFERENCES plans(code) DEFAULT 'growth',
  seats INT NOT NULL DEFAULT 1,
  trial_ends_at TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  razorpay_subscription_id TEXT,
  razorpay_customer_id TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- email -> tenant routing for sign-in (one email belongs to one tenant)
CREATE TABLE IF NOT EXISTS accounts (
  email TEXT PRIMARY KEY,
  tenant_id INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id INT NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_events (
  id SERIAL PRIMARY KEY,
  tenant_id INT REFERENCES tenants(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
