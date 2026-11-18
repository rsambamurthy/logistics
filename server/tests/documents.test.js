import test from 'node:test';
import assert from 'node:assert/strict';
import { requiredDocs, checklist, missingFromCustomer, compareToSi, correctionsText, docName } from '../engines/documents.js';

const rfq = { mode: 'FCL', legs: ['pickup', 'export_customs', 'origin_charges', 'freight'], dangerous_goods: false };

test('required documents follow legs, mode and country', () => {
  assert.deepEqual(requiredDocs(rfq, 'IN'), ['invoice', 'packing_list', 'si', 'vgm', 'shipping_bill', 'bl']);
  assert.deepEqual(requiredDocs({ mode: 'AIR', legs: ['freight', 'import_customs'], dangerous_goods: true }, 'HK'), ['invoice', 'packing_list', 'si', 'import_declaration', 'dg_declaration', 'bl']);
  assert.equal(docName('bl', 'AIR'), 'Air waybill');
});

test('checklist status', () => {
  const rows = checklist({ rfq, country: 'IN', files: [{ id: 1, kind: 'invoice' }], waived: ['vgm'], si: { status: 'sent' }, bls: [{ is_final: false }] });
  const st = Object.fromEntries(rows.map((r) => [r.code, r.status]));
  assert.deepEqual(st, { invoice: 'received', packing_list: 'missing', si: 'sent', vgm: 'waived', shipping_bill: 'missing', bl: 'draft' });
  assert.deepEqual(missingFromCustomer(rows), ['packing_list']);
});

test('draft BL compared with SI', () => {
  const si = {
    shipper: { name: 'Acme Exports Pvt Ltd', address: '12 Mount Road, Chennai 600002' },
    consignee: { name: 'HK Imports Ltd', address: 'Kwun Tong, Hong Kong' },
    pod: 'Hong Kong (HKHKG)', description: '200 cartons auto parts', packages: 200, gross_weight_kg: 4500, hs_code: '8708',
    containers: [{ number: 'TCLU 123456-7', seal: 'S1' }, { number: 'MSCU7654321', seal: 'S2' }],
  };
  const bl = {
    shipper: 'ACME EXPORTS PVT. LTD., 12 MOUNT ROAD, CHENNAI 600002',
    consignee: 'HK IMPORT LIMITED, KWUN TONG',
    pod: 'HONG KONG', description: '200 CARTONS AUTO PARTS', packages: '200 CTNS', gross_weight_kg: '4,600.00',
    containers: [{ number: 'TCLU1234567', seal: 'S1' }, { number: 'MSCU7654321', seal: 'S9' }],
  };
  const d = compareToSi(si, bl);
  assert.deepEqual(d.map((x) => `${x.label}:${x.kind}`), ['Consignee:different', 'HS code:missing', 'Gross weight (kg):different', 'Seal of MSCU7654321:different']);
  assert.match(correctionsText(d), /Gross weight \(kg\): should read "4500"/);
});
