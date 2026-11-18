// AI agents: read partner-agent replies and customer enquiries into structured data.
import { getAiKey, getSetting } from './settings.js';
import { LEG_CODES, BASIS_CODES, CHARGE_CODES, CURRENCIES, CONTAINER_TYPES, INCOTERMS, normaliseCharge, normaliseBasis, legName } from '../engines/charges.js';

const API_URL = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1/messages';

async function callTool({ system, content, tool, maxTokens = 4000 }) {
  const key = await getAiKey();
  if (!key) throw new Error('AI key not configured. Add it in Settings → AI.');
  const { model } = await getSetting('ai');
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
      messages: [{ role: 'user', content }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`AI error ${res.status}: ${body?.error?.message || JSON.stringify(body).slice(0, 300)}`);
  const block = (body.content || []).find((b) => b.type === 'tool_use');
  if (!block) throw new Error('AI returned no structured result');
  return block.input;
}

const chargeList = CHARGE_CODES.map((c) => `${c.code} = ${c.name} (usual leg: ${c.leg})`).join('\n');

const QUOTE_TOOL = {
  name: 'record_agent_quote',
  description: 'Record the rate quotation contained in a partner agent email reply.',
  input_schema: {
    type: 'object',
    properties: {
      is_quote: { type: 'boolean', description: 'True if the email contains prices. False if it is only an acknowledgement, question or out-of-office.' },
      declined: { type: 'boolean', description: 'True if the agent says they cannot quote / no service.' },
      message_summary: { type: 'string', description: 'One line summary of what the agent said.' },
      valid_until: { type: 'string', description: 'Quote validity date YYYY-MM-DD if stated.' },
      transit_days: { type: 'integer' },
      free_days: { type: 'integer', description: 'Free days at destination (detention/demurrage) if stated.' },
      carrier: { type: 'string', description: 'Shipping line or airline if stated.' },
      routing: { type: 'string', description: 'Routing / transhipment if stated.' },
      remarks: { type: 'string', description: 'Important conditions (subject to, space, etc).' },
      exclusions: { type: 'string', description: 'Charges the agent explicitly excludes or says are at actuals.' },
      overall_confidence: { type: 'number', description: '0-1 confidence the extraction is complete and correct.' },
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            leg: { type: 'string', enum: LEG_CODES },
            charge_name: { type: 'string', description: 'Charge name exactly as the agent wrote it.' },
            charge_code: { type: 'string', enum: CHARGE_CODES.map((c) => c.code) },
            basis: { type: 'string', enum: BASIS_CODES },
            rate: { type: 'number', description: 'Unit rate (not total) unless the agent only gave a lump sum, in which case basis=per_shipment.' },
            currency: { type: 'string', description: 'ISO currency code, e.g. USD, INR, HKD.' },
            confidence: { type: 'number', description: '0-1 confidence for this line.' },
          },
          required: ['leg', 'charge_name', 'charge_code', 'basis', 'rate', 'currency', 'confidence'],
        },
      },
    },
    required: ['is_quote', 'declined', 'lines', 'overall_confidence', 'message_summary'],
  },
};

export function rfqContext(rfq) {
  const cont = (rfq.containers || []).map((c) => `${c.qty}x${c.type}`).join(', ');
  return [
    `RFQ ${rfq.ref} — mode ${rfq.mode}`,
    `From: ${rfq.pickup_place ? rfq.pickup_place + ' via ' : ''}${rfq.pol || '-'}  To: ${rfq.pod || '-'}${rfq.delivery_place ? ' → ' + rfq.delivery_place : ''}`,
    cont && `Equipment: ${cont}`,
    rfq.gross_weight_kg && `Weight: ${rfq.gross_weight_kg} kg`,
    rfq.volume_cbm && `Volume: ${rfq.volume_cbm} cbm`,
    rfq.commodity && `Commodity: ${rfq.commodity}`,
    rfq.incoterm && `Incoterm: ${rfq.incoterm}`,
  ].filter(Boolean).join('\n');
}

export async function parseAgentReply({ rfq, invite, email, attachmentBlocks }) {
  const system = `You extract freight rate quotations from emails sent by partner agents (forwarders, co-loaders, NVOCCs, transporters, customs brokers) to a C&F agent in India or Hong Kong.
Rules:
- Only extract prices from the agent's NEW reply. Ignore the quoted original RFQ text and older messages in the thread.
- Read tables in the email body and in attachments (PDF, Excel, images).
- Give unit rates with the correct basis. "USD 650/40HC" → rate 650, basis per_40 (or per_container if only one container type). "INR 2500 per BL" → per_bl. Lump sums → per_shipment.
- Assign each charge to the shipment leg it belongs to. Requested legs are listed; still record other charges the agent adds.
- Use charge code OTHER when nothing fits, and keep the agent's wording in charge_name.
- If a charge is "at actuals" or "extra", do not invent a price: put it in exclusions.
- If they quote multiple options (e.g. two carriers), record only the cheapest complete option and describe the others in remarks.
- Lower the confidence when numbers are ambiguous, handwritten, or currency/basis is unclear.
Standard charge codes:\n${chargeList}`;
  const content = [
    { type: 'text', text: `Our RFQ:\n${rfqContext(rfq)}\nLegs requested from this agent: ${(invite.legs || []).map(legName).join(', ')}\nToday: ${new Date().toISOString().slice(0, 10)}` },
    { type: 'text', text: `Agent email\nFrom: ${email.from_addr}\nSubject: ${email.subject}\n\n${(email.body_text || '').slice(0, 40000)}` },
    ...attachmentBlocks,
  ];
  const out = await callTool({ system, content, tool: QUOTE_TOOL, maxTokens: 6000 });
  return sanitizeQuote(out);
}

export function sanitizeQuote(out) {
  const lines = (out.lines || []).map((l, i) => {
    const leg = LEG_CODES.includes(l.leg) ? l.leg : 'freight';
    const code = CHARGE_CODES.some((c) => c.code === l.charge_code) ? l.charge_code : normaliseCharge(l.charge_name, leg);
    return {
      leg,
      charge_code: code,
      description: l.charge_name || code,
      basis: BASIS_CODES.includes(l.basis) ? l.basis : normaliseBasis(l.basis),
      rate: Number(l.rate) || 0,
      currency: String(l.currency || 'USD').toUpperCase().slice(0, 3),
      confidence: Math.max(0, Math.min(1, Number(l.confidence ?? 0.5))),
      sort: i,
    };
  });
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(out.valid_until || '') ? out.valid_until : null;
  return {
    is_quote: !!out.is_quote,
    declined: !!out.declined,
    summary: out.message_summary || '',
    valid_until: valid,
    transit_days: Number.isInteger(out.transit_days) ? out.transit_days : null,
    free_days: Number.isInteger(out.free_days) ? out.free_days : null,
    carrier: out.carrier || null,
    routing: out.routing || null,
    remarks: [out.message_summary, out.remarks].filter(Boolean).join(' — ') || null,
    exclusions: out.exclusions || null,
    confidence: Math.max(0, Math.min(1, Number(out.overall_confidence ?? 0.5))),
    lines,
  };
}

const ENQUIRY_TOOL = {
  name: 'record_enquiry',
  description: 'Record shipment details from a customer enquiry.',
  input_schema: {
    type: 'object',
    properties: {
      customer_name: { type: 'string' },
      mode: { type: 'string', enum: ['FCL', 'LCL', 'AIR'] },
      pol: { type: 'string', description: 'Port/airport of loading, name and UN/LOCODE if obvious, e.g. "Chennai (INMAA)"' },
      pod: { type: 'string' },
      pickup_place: { type: 'string', description: 'Door pickup location if the customer wants pickup' },
      delivery_place: { type: 'string', description: 'Door delivery location if requested' },
      incoterm: { type: 'string', enum: INCOTERMS },
      commodity: { type: 'string' },
      containers: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: CONTAINER_TYPES }, qty: { type: 'integer' } }, required: ['type', 'qty'] } },
      packages: { type: 'integer' },
      gross_weight_kg: { type: 'number' },
      volume_cbm: { type: 'number' },
      ready_date: { type: 'string', description: 'YYYY-MM-DD' },
      legs: { type: 'array', items: { type: 'string', enum: LEG_CODES }, description: 'Which legs need pricing given the incoterm and door requirements' },
      notes: { type: 'string', description: 'Special requirements (hazardous, temperature, insurance, etc.)' },
      requester_reference: { type: 'string', description: "The sender's own enquiry/job reference number, if any" },
      hs_code: { type: 'string' },
      dangerous_goods: { type: 'boolean' },
      dg_class: { type: 'string', description: 'IMO/IATA hazard class if dangerous' },
      un_number: { type: 'string' },
      reefer_temp: { type: 'string', description: 'Required temperature for reefer cargo, e.g. "-18 C"' },
      dimensions: { type: 'string', description: 'Package dimensions as given, e.g. "4 pallets 120x100x150 cm"' },
    },
    required: ['mode', 'legs'],
  },
};

export async function parseEnquiry(text) {
  const system = `You read customer shipping enquiries for a C&F (clearing & forwarding) agent in India or Hong Kong and extract structured shipment details. Infer which legs need pricing: e.g. export EXW with door pickup → pickup, export_customs, origin_charges, freight; DDP → all legs. Use today's year when a date has no year. Today: ${new Date().toISOString().slice(0, 10)}.`;
  return callTool({ system, content: [{ type: 'text', text: text.slice(0, 30000) }], tool: ENQUIRY_TOOL, maxTokens: 2000 });
}

const CLASSIFY_TOOL = {
  name: 'classify_email',
  description: 'Classify an email that arrived in the RFQ mailbox of a C&F / freight forwarding company.',
  input_schema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['quote_reply', 'new_enquiry', 'other'],
        description: 'quote_reply = the sender is giving us prices/answering our earlier rate request. new_enquiry = the sender is ASKING US for a rate/quotation for a shipment (for themselves or for their own customer). other = anything else (newsletters, invoices, bookings, spam, out-of-office).',
      },
      confidence: { type: 'number' },
      reason: { type: 'string' },
    },
    required: ['type', 'confidence'],
  },
};

export async function classifyEmail(email) {
  const system = 'You triage incoming emails for a freight forwarder / C&F agent in India or Hong Kong. The company both asks partner agents for rates and receives rate requests from customers and partner agents. Decide what this email is.';
  const content = [{ type: 'text', text: `From: ${email.from_addr}\nSubject: ${email.subject}\n\n${(email.body_text || '').slice(0, 15000)}` }];
  return callTool({ system, content, tool: CLASSIFY_TOOL, maxTokens: 500 });
}

export { CURRENCIES };
