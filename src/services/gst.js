// GST helpers: state codes, GSTIN validation, CGST/SGST vs IGST split, amounts in words, financial year.

export const GST_STATES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
};

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Format + check-digit validation of a GSTIN. */
export function isValidGstin(gstin) {
  const g = String(gstin || '').toUpperCase();
  if (!GSTIN_RE.test(g) || !GST_STATES[g.slice(0, 2)]) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(g[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36] === g[14];
}

/**
 * Split a total that INCLUDES GST into taxable value and tax.
 * Same state as the seller -> CGST + SGST (half each), otherwise IGST.
 */
export function splitInclusive(totalPaise, ratePercent, sellerState, buyerState) {
  if (!ratePercent) return { taxable: totalPaise, cgst: 0, sgst: 0, igst: 0, tax: 0 };
  const taxable = Math.round((totalPaise * 100) / (100 + ratePercent));
  const tax = totalPaise - taxable;
  if (sellerState === buyerState) {
    const cgst = Math.round(tax / 2);
    return { taxable, cgst, sgst: tax - cgst, igst: 0, tax };
  }
  return { taxable, cgst: 0, sgst: 0, igst: tax, tax };
}

/** Plan price (exclusive of GST) -> amount charged including GST, in paise. */
export const withGst = (rupees, ratePercent) => Math.round(rupees * 100 * (1 + (ratePercent || 0) / 100));

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const two = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`);
const three = (n) => [n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred` : '', two(n % 100)].filter(Boolean).join(' ');

/** 4128.82 -> "Rupees Four Thousand One Hundred Twenty Eight and Eighty Two Paise Only" (Indian grouping). */
export function amountInWords(paise) {
  const rupees = Math.floor(paise / 100);
  const p = paise % 100;
  const parts = [];
  const crore = Math.floor(rupees / 1e7);
  const lakh = Math.floor((rupees % 1e7) / 1e5);
  const thousand = Math.floor((rupees % 1e5) / 1000);
  const rest = rupees % 1000;
  if (crore) parts.push(`${three(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (rest) parts.push(three(rest));
  const words = parts.join(' ') || 'Zero';
  return `Rupees ${words}${p ? ` and ${two(p)} Paise` : ''} Only`;
}

/** Indian financial year label for a date: April 2026 - March 2027 -> "2026-27". */
export function financialYear(date = new Date()) {
  const y = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

export const formatInr = (paise) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
