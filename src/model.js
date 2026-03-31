import { PA, BR_LIMIT, HR_LIMIT, BR_RATE, HR_RATE, AR_RATE } from './constants.js';

export function incomeTax(taxable) {
  if (taxable <= 0) return 0;
  const effectivePA = taxable > 100000 ? Math.max(0, PA - (taxable - 100000) / 2) : PA;
  const above = Math.max(0, taxable - effectivePA);
  const effectiveBRL = Math.max(0, (PA + BR_LIMIT) - effectivePA);
  const br = Math.min(above, effectiveBRL);
  let tax = br * BR_RATE;
  const hr = Math.min(Math.max(0, above - effectiveBRL), HR_LIMIT - PA - BR_LIMIT);
  tax += hr * HR_RATE;
  const ar = Math.max(0, above - (HR_LIMIT - effectivePA));
  tax += ar * AR_RATE;
  return tax;
}

export function calcPensionTax(grossDrawdown, statePension, hasStatePension, taxFreeFrac) {
  const taxFree = grossDrawdown * taxFreeFrac;
  const pensionTaxable = grossDrawdown * (1 - taxFreeFrac);
  const spTaxable = hasStatePension ? statePension : 0;
  const totalTaxable = pensionTaxable + spTaxable;
  const totalTax = incomeTax(totalTaxable);
  const pensionTaxShare = totalTaxable > 0 ? totalTax * (pensionTaxable / totalTaxable) : 0;
  const spTaxShare = totalTaxable > 0 ? totalTax * (spTaxable / totalTaxable) : 0;
  return {
    taxFree,
    pensionTaxable,
    pensionTax: pensionTaxShare,
    spTaxable,
    spTax: spTaxShare,
    pensionNet: grossDrawdown - pensionTaxShare,
    spNet: statePension - spTaxShare,
  };
}

export function calcOtherIncomesNet(incomes, inflFactor) {
  let grossTotal = 0, taxTotal = 0, netTotal = 0;
  const items = incomes.map(inc => {
    const annualAmt = inc.frequency === 'monthly' ? inc.amount * 12 : inc.amount;
    const gross = annualAmt * (inc.inflationLinked ? inflFactor : 1);
    const tax = gross * (inc.taxPct / 100);
    const net = gross - tax;
    grossTotal += gross;
    taxTotal += tax;
    netTotal += net;
    return { name: inc.name, gross, tax, net };
  });
  return { grossTotal, taxTotal, netTotal, items };
}
