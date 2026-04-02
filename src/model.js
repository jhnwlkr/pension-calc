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

export function calcPensionTax(grossDrawdown, statePension, hasStatePension, taxFreeFrac, otherGross = 0) {
  const taxFree = grossDrawdown * taxFreeFrac;
  const pensionTaxable = grossDrawdown * (1 - taxFreeFrac);
  const spTaxable = hasStatePension ? statePension : 0;
  const totalTaxable = pensionTaxable + spTaxable + otherGross;
  const totalTax = incomeTax(totalTaxable);
  const pensionTaxShare = totalTaxable > 0 ? totalTax * (pensionTaxable / totalTaxable) : 0;
  const spTaxShare = totalTaxable > 0 ? totalTax * (spTaxable / totalTaxable) : 0;
  const otherTaxShare = totalTaxable > 0 ? totalTax * (otherGross / totalTaxable) : 0;
  return {
    taxFree,
    pensionTaxable,
    pensionTax: pensionTaxShare,
    spTaxable,
    spTax: spTaxShare,
    otherTax: otherTaxShare,
    otherNet: otherGross - otherTaxShare,
    pensionNet: grossDrawdown - pensionTaxShare,
    spNet: statePension - spTaxShare,
  };
}

/** Returns the per-band breakdown of income tax so renderers can show the workings. */
export function incomeTaxBands(taxable) {
  if (taxable <= 0) {
    return { effectivePA: PA, paUsed: 0, above: 0, brAmount: 0, brTax: 0, hrAmount: 0, hrTax: 0, arAmount: 0, arTax: 0, totalTax: 0 };
  }
  const effectivePA = taxable > 100000 ? Math.max(0, PA - (taxable - 100000) / 2) : PA;
  const paUsed = Math.min(effectivePA, taxable);
  const above = Math.max(0, taxable - effectivePA);
  const effectiveBRL = Math.max(0, (PA + BR_LIMIT) - effectivePA);
  const brAmount = Math.min(above, effectiveBRL);
  const brTax = brAmount * BR_RATE;
  const hrAmount = Math.min(Math.max(0, above - effectiveBRL), HR_LIMIT - PA - BR_LIMIT);
  const hrTax = hrAmount * HR_RATE;
  const arAmount = Math.max(0, above - (HR_LIMIT - effectivePA));
  const arTax = arAmount * AR_RATE;
  return { effectivePA, paUsed, above, brAmount, brTax, hrAmount, hrTax, arAmount, arTax, totalTax: brTax + hrTax + arTax };
}

export function calcOtherIncomesNet(incomes, inflFactor) {
  let grossTotal = 0;
  const items = incomes.map(inc => {
    const annualAmt = inc.frequency === 'monthly' ? inc.amount * 12 : inc.amount;
    const gross = annualAmt * (inc.inflationLinked ? inflFactor : 1);
    grossTotal += gross;
    return { name: inc.name, gross, tax: 0, net: gross };
  });
  return { grossTotal, taxTotal: 0, netTotal: grossTotal, items };
}
