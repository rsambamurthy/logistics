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

const RATESHEET_TOOL = {
  name: 'record_rate_cards',
  description: 'Record the buy rates found in a carrier / agent / transporter rate sheet as rate cards.',
  input_schema: {
    type: 'object',
    properties: {
      cards: {
        type: 'array',
        description: 'One card per leg + lane + mode (+ carrier). Put container types as separate lines of the same card.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short name, e.g. "ONE MAA-HKG Dec 2026"' },
            leg: { type: 'string', enum: LEG_CODES },
            mode: { type: 'string', enum: ['FCL', 'LCL', 'AIR', 'ANY'] },
            origin: { type: 'string', description: 'Port/airport/place names and codes, comma separated, e.g. "Chennai, INMAA"' },
            destination: { type: 'string' },
            carrier: { type: 'string' },
            valid_from: { type: 'string', description: 'YYYY-MM-DD' },
            valid_to: { type: 'string', description: 'YYYY-MM-DD' },
            transit_days: { type: 'integer' },
            free_days: { type: 'integer' },
            lines: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  charge_code: { type: 'string', enum: CHARGE_CODES.map((c) => c.code) },
                  description: { type: 'string' },
                  basis: { type: 'string', enum: BASIS_CODES },
                  equipment: { type: 'string', enum: CONTAINER_TYPES, description: 'Container type for FCL rates; omit if the charge applies to all containers' },
                  rate: { type: 'number' },
                  currency: { type: 'string' },
                  qty_from: { type: 'number', description: 'Weight/volume break start (kg or cbm)' },
                  qty_to: { type: 'number' },
                  min_amount: { type: 'number', description: 'Minimum charge' },
                },
                required: ['charge_code', 'basis', 'rate', 'currency'],
              },
            },
          },
          required: ['name', 'leg', 'lines'],
        },
      },
      notes: { type: 'string', description: 'Conditions or anything that could not be captured' },
    },
    required: ['cards'],
  },
};

/** Read a carrier / agent rate sheet (any layout: PDF, Excel, image, email text) into rate cards. */
export async function readRateSheet({ blocks, hint }) {
  const system = `You convert freight rate sheets into structured buy-rate cards for a C&F agent in India / Hong Kong.
- Each card = one leg (pickup, export_customs, origin_charges, freight, destination_charges, import_customs, delivery) for one lane and mode.
- Ocean rates per container type go as separate lines with equipment set (20GP, 40GP, 40HC...). Surcharges that apply to every container have no equipment.
- Air rates with weight breaks: one line per break with qty_from/qty_to in kg and basis per_kg; minimum charge in min_amount.
- Local charges (THC, documentation, BL fee, seal) belong to origin_charges or destination_charges.
- Use the sheet's validity dates. Do not invent rates. Use charge code OTHER when nothing fits.
Standard charge codes:
${chargeList}
Today: ${new Date().toISOString().slice(0, 10)}`;
  const content = [{ type: 'text', text: `Rate sheet${hint ? ` (${hint})` : ''}:` }, ...blocks];
  const out = await callTool({ system, content, tool: RATESHEET_TOOL, maxTokens: 16000 });
  const valid = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : null);
  return {
    notes: out.notes || null,
    cards: (out.cards || []).map((c) => ({
      name: c.name,
      leg: LEG_CODES.includes(c.leg) ? c.leg : 'freight',
      mode: ['FCL', 'LCL', 'AIR'].includes(c.mode) ? c.mode : null,
      origin: c.origin || null,
      destination: c.destination || null,
      carrier: c.carrier || null,
      valid_from: valid(c.valid_from),
      valid_to: valid(c.valid_to),
      transit_days: Number.isInteger(c.transit_days) ? c.transit_days : null,
      free_days: Number.isInteger(c.free_days) ? c.free_days : null,
      active: true,
      lines: (c.lines || []).map((l) => ({
        charge_code: CHARGE_CODES.some((x) => x.code === l.charge_code) ? l.charge_code : normaliseCharge(l.description),
        description: l.description || null,
        basis: BASIS_CODES.includes(l.basis) ? l.basis : normaliseBasis(l.basis),
        equipment: CONTAINER_TYPES.includes(l.equipment) ? l.equipment : null,
        rate: Number(l.rate) || 0,
        currency: String(l.currency || 'USD').toUpperCase().slice(0, 3),
        qty_from: l.qty_from ?? null,
        qty_to: l.qty_to ?? null,
        min_amount: l.min_amount ?? null,
      })),
    })).filter((c) => c.lines.length),
  };
}

const BOOKING_TOOL = {
  name: 'record_booking_confirmation',
  description: "Record the booking details in an agent's or carrier's reply to a booking request.",
  input_schema: {
    type: 'object',
    properties: {
      is_confirmation: { type: 'boolean', description: 'True if the email confirms a booking (booking number, vessel/flight or schedule given).' },
      rejected: { type: 'boolean', description: 'True if the agent says the booking cannot be made (no space, rate changed, etc.).' },
      message_summary: { type: 'string' },
      booking_no: { type: 'string', description: 'Booking / reference number from the carrier or agent' },
      carrier: { type: 'string', description: 'Shipping line or airline' },
      vessel: { type: 'string' },
      voyage: { type: 'string' },
      flight_no: { type: 'string' },
      mbl_awb: { type: 'string', description: 'Master BL or AWB number if given' },
      pol: { type: 'string' },
      pod: { type: 'string' },
      etd: { type: 'string', description: 'Estimated departure, ISO date or datetime (YYYY-MM-DD or YYYY-MM-DDTHH:MM)' },
      eta: { type: 'string' },
      cutoff_si: { type: 'string', description: 'SI / documentation cut-off, ISO datetime' },
      cutoff_vgm: { type: 'string', description: 'VGM cut-off, ISO datetime' },
      cutoff_gate_in: { type: 'string', description: 'CY / gate-in / cargo cut-off, ISO datetime' },
      cutoff_docs: { type: 'string', description: 'Other document cut-off, ISO datetime' },
      cutoff_customs: { type: 'string', description: 'Customs cut-off, ISO datetime' },
      empty_pickup: { type: 'string', description: 'Empty container pick-up depot / yard' },
      container_numbers: { type: 'array', items: { type: 'string' } },
      remarks: { type: 'string', description: 'Conditions or instructions (e.g. rate valid only for this sailing)' },
      confidence: { type: 'number', description: '0-1' },
    },
    required: ['is_confirmation', 'rejected', 'confidence', 'message_summary'],
  },
};

/** Read a booking confirmation (email text plus PDF/image attachments). */
export async function parseBookingReply({ job, booking, email, attachmentBlocks }) {
  const system = `You read booking confirmations from partner agents / carriers for a C&F agent in India or Hong Kong.
Only use the agent's NEW reply, not the quoted booking request. Dates: convert to ISO (YYYY-MM-DD or YYYY-MM-DDTHH:MM), assume the current or next year when the year is missing. Today: ${new Date().toISOString().slice(0, 10)}. Do not invent values.`;
  const content = [
    { type: 'text', text: `Our job ${job.ref}. Booking requested for legs: ${(booking.legs || []).join(', ')}.` },
    { type: 'text', text: `Agent email\nFrom: ${email.from_addr}\nSubject: ${email.subject}\n\n${(email.body_text || '').slice(0, 30000)}` },
    ...attachmentBlocks,
  ];
  const out = await callTool({ system, content, tool: BOOKING_TOOL, maxTokens: 3000 });
  // keep the agent's local times as written (no time-zone shift): 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM'
  const dt = (v) => { const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(String(v || '')); return m ? (m[2] ? `${m[1]}T${m[2]}` : m[1]) : null; };
  const d = (v) => dt(v)?.slice(0, 10) || null;
  return {
    is_confirmation: !!out.is_confirmation,
    rejected: !!out.rejected,
    summary: out.message_summary || '',
    booking_no: out.booking_no || null,
    carrier: out.carrier || null,
    vessel: out.vessel || null,
    voyage: out.voyage || null,
    flight_no: out.flight_no || null,
    mbl_awb: out.mbl_awb || null,
    pol: out.pol || null,
    pod: out.pod || null,
    etd: d(out.etd),
    eta: d(out.eta),
    cutoffs: Object.fromEntries(Object.entries({ si: out.cutoff_si, vgm: out.cutoff_vgm, gate_in: out.cutoff_gate_in, docs: out.cutoff_docs, customs: out.cutoff_customs }).map(([k, v]) => [k, dt(v)]).filter(([, v]) => v)),
    empty_pickup: out.empty_pickup || null,
    container_nos: Array.isArray(out.container_numbers) ? out.container_numbers.filter(Boolean) : [],
    remarks: out.remarks || null,
    confidence: Math.max(0, Math.min(1, Number(out.confidence ?? 0.5))),
  };
}

export { CURRENCIES };
