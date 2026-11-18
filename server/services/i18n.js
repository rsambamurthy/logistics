// Labels for customer-facing documents. English and Traditional Chinese (Hong Kong).
const L = {
  en: {
    quotation: 'QUOTATION', to: 'To', your_ref: 'Your reference', date: 'Date', valid_until: 'Valid until', route: 'Route', mode: 'Mode',
    cargo: 'Equipment / cargo', incoterm: 'Incoterm', commodity: 'Commodity', hs_code: 'HS code', dg: 'Dangerous goods', reefer: 'Reefer temperature',
    dimensions: 'Dimensions', charge: 'Charge', basis: 'Basis', qty: 'Qty', rate: 'Rate', amount: 'Amount', subtotal: 'Subtotal', total: 'Total',
    tax: 'Tax', grand_total: 'Grand total', terms: 'Terms & conditions', bank: 'Bank details', option: 'Option', options_summary: 'Options at a glance',
    transit: 'Transit', days: 'days', replaces: 'This revision replaces', changes: 'Changes', sea: 'Sea', air: 'Air',
    bank_name: 'Bank', account_name: 'Account name', account_no: 'Account no.', ifsc: 'IFSC', swift: 'SWIFT', branch: 'Branch',
  },
  zh: {
    quotation: '報價單', to: '致', your_ref: '貴司參考編號', date: '日期', valid_until: '有效期至', route: '航線', mode: '運輸方式',
    cargo: '櫃型 / 貨物', incoterm: '貿易條款', commodity: '貨物名稱', hs_code: 'HS 編碼', dg: '危險品', reefer: '冷藏溫度',
    dimensions: '尺寸', charge: '費用項目', basis: '計費方式', qty: '數量', rate: '單價', amount: '金額', subtotal: '小計', total: '合計',
    tax: '稅項', grand_total: '總計', terms: '條款及細則', bank: '銀行資料', option: '方案', options_summary: '方案一覽',
    transit: '航程', days: '天', replaces: '本修訂版取代', changes: '變更', sea: '海運', air: '空運',
    bank_name: '銀行', account_name: '戶口名稱', account_no: '戶口號碼', ifsc: 'IFSC', swift: 'SWIFT', branch: '分行',
  },
};

const LEGS_ZH = { pickup: '起運地拖運 / 提貨', export_customs: '出口報關', origin_charges: '起運港費用', freight: '主運費（海運 / 空運）', destination_charges: '目的港費用', import_customs: '進口清關', delivery: '目的地派送' };
const BASES_ZH = { per_shipment: '每票', per_container: '每櫃', per_20: "每20'櫃", per_40: "每40'櫃", per_cbm: '每立方米', per_kg: '每公斤（計費重）', per_wm: '每計費噸 (W/M)', per_bl: '每提單 / 空運單', per_declaration: '每份報關單', per_trip: '每車次' };
export const legLabel = (lang, code, fallback) => (lang === 'zh' ? LEGS_ZH[code] : null) || fallback;
export const basisLabel = (lang, code, fallback) => (lang === 'zh' ? BASES_ZH[code] : null) || fallback;

export const LANGUAGES = [{ code: 'en', name: 'English' }, { code: 'zh', name: '繁體中文 (Traditional Chinese)' }];
export const t = (lang) => (key) => (L[lang] || L.en)[key] ?? L.en[key] ?? key;
