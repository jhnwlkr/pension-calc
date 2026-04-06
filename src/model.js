import {
  PA, BR_LIMIT, HR_LIMIT, BR_RATE, HR_RATE, AR_RATE,
  DIV_BR_RATE, DIV_HR_RATE, DIV_AR_RATE, DIV_BR_RATE_OLD, DIV_HR_RATE_OLD,
  PROP_SAV_BR_RATE, PROP_SAV_HR_RATE, PROP_SAV_AR_RATE,
  DIV_RATE_CHANGE_YEAR, PROP_SAV_RATE_CHANGE_YEAR,
} from './constants.js';

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

/** Standard income tax using a pre-computed effectivePA (avoids recalculating the taper). */
function incomeTaxGivenPA(taxable, effectivePA) {
  if (taxable <= 0) return 0;
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

/**
 * Computes tax on `income` that stacks ON TOP of `lowerTiersBase` of already-used income,
 * applying custom rates (brRate/hrRate/arRate) — used for property, savings and dividend tiers.
 * Any personal allowance not consumed by lower tiers flows into this tier first.
 */
function calcStackedTax(income, lowerTiersBase, effectivePA, brRate, hrRate, arRate) {
  if (income <= 0) return 0;
  // PA not yet consumed by lower tiers
  const paFlowsHere = Math.max(0, effectivePA - lowerTiersBase);
  const taxable = Math.max(0, income - paFlowsHere);
  if (taxable <= 0) return 0;
  // How much of the basic-rate band (BR_LIMIT wide above effectivePA) is left after lower tiers
  const basicBandUsed = Math.max(0, lowerTiersBase - effectivePA);
  const basicLeft = Math.max(0, BR_LIMIT - basicBandUsed);
  const br = Math.min(taxable, basicLeft);
  let tax = br * brRate;
  const higherBandUsed = Math.max(0, basicBandUsed - BR_LIMIT);
  const higherLeft = Math.max(0, (HR_LIMIT - PA - BR_LIMIT) - higherBandUsed);
  const hr = Math.min(Math.max(0, taxable - basicLeft), higherLeft);
  tax += hr * hrRate;
  const ar = Math.max(0, taxable - basicLeft - higherLeft);
  tax += ar * arRate;
  return tax;
}

/**
 * Computes tax for a person's full income in a given simulation year, using the correct
 * UK stacking order (ITA 2007 s23) and the right rate schedule for each income type.
 *
 * From 6 Apr 2026: dividends taxed at 10.75/35.75/39.35% (already live)
 * From 6 Apr 2027: property and savings taxed at 22/42/47%; they become a separate tier
 *
 * Stacking order:
 *   Tier 1 (non-savings): pension drawdown + state pension + employment income
 *   Tier 2 (property):    property / rental income (standard rates until 2027, then 22/42/47%)
 *   Tier 3 (savings):     savings / interest income (same schedule as property)
 *   Tier 4 (dividends):   dividend income (10.75/35.75/39.35% from 2026, 8.75/33.75% before)
 *
 * @param {number} grossDrawdown
 * @param {number} statePension
 * @param {boolean} hasStatePension
 * @param {number} taxFreeFrac
 * @param {{ employment?: number, property?: number, savings?: number, dividends?: number }|number} otherByType
 *   Pass an object keyed by income type, or a plain number for backward compatibility
 *   (plain number is treated as employment income).
 * @param {number} calYear  Calendar year of this simulation year (e.g. 2027)
 */
export function calcPensionTax(grossDrawdown, statePension, hasStatePension, taxFreeFrac, otherByType = 0, calYear = 2026) {
  const taxFree = grossDrawdown * taxFreeFrac;
  const pensionTaxable = grossDrawdown * (1 - taxFreeFrac);
  const spTaxable = hasStatePension ? statePension : 0;

  // Backward compat: plain number → treat as employment
  let employment = 0, property = 0, savings = 0, dividends = 0;
  if (typeof otherByType === 'number') {
    employment = otherByType;
  } else {
    employment = otherByType.employment || 0;
    property   = otherByType.property   || 0;
    savings    = otherByType.savings    || 0;
    dividends  = otherByType.dividends  || 0;
  }

  // Effective personal allowance — computed from TOTAL income across all tiers
  const totalTaxable = pensionTaxable + spTaxable + employment + property + savings + dividends;
  const effectivePA = totalTaxable > 100000 ? Math.max(0, PA - (totalTaxable - 100000) / 2) : PA;

  // ── Tier 1: non-savings (pension + SP + employment) ──────────────────────
  const t1 = pensionTaxable + spTaxable + employment;
  const t1Tax = incomeTaxGivenPA(t1, effectivePA);
  // Attribution within tier 1 by diff-stacking
  const pensionTax    = incomeTaxGivenPA(pensionTaxable, effectivePA);
  const spTax         = incomeTaxGivenPA(pensionTaxable + spTaxable, effectivePA) - pensionTax;
  const employmentTax = t1Tax - pensionTax - spTax;

  // ── Tier 2: property ──────────────────────────────────────────────────────
  const propBR = calYear >= PROP_SAV_RATE_CHANGE_YEAR ? PROP_SAV_BR_RATE : BR_RATE;
  const propHR = calYear >= PROP_SAV_RATE_CHANGE_YEAR ? PROP_SAV_HR_RATE : HR_RATE;
  const propAR = calYear >= PROP_SAV_RATE_CHANGE_YEAR ? PROP_SAV_AR_RATE : AR_RATE;
  const propertyTax = calcStackedTax(property, t1, effectivePA, propBR, propHR, propAR);

  // ── Tier 3: savings ───────────────────────────────────────────────────────
  const savBR = calYear >= PROP_SAV_RATE_CHANGE_YEAR ? PROP_SAV_BR_RATE : BR_RATE;
  const savHR = calYear >= PROP_SAV_RATE_CHANGE_YEAR ? PROP_SAV_HR_RATE : HR_RATE;
  const savAR = calYear >= PROP_SAV_RATE_CHANGE_YEAR ? PROP_SAV_AR_RATE : AR_RATE;
  const savingsTax = calcStackedTax(savings, t1 + property, effectivePA, savBR, savHR, savAR);

  // ── Tier 4: dividends ─────────────────────────────────────────────────────
  const divBR = calYear >= DIV_RATE_CHANGE_YEAR ? DIV_BR_RATE : DIV_BR_RATE_OLD;
  const divHR = calYear >= DIV_RATE_CHANGE_YEAR ? DIV_HR_RATE : DIV_HR_RATE_OLD;
  const dividendTax = calcStackedTax(dividends, t1 + property + savings, effectivePA, divBR, divHR, DIV_AR_RATE);

  const otherTax = employmentTax + propertyTax + savingsTax + dividendTax;
  const otherGross = employment + property + savings + dividends;

  return {
    taxFree,
    pensionTaxable,
    pensionTax,
    spTaxable,
    spTax,
    // Typed other-income tax (useful for Tax Breakdown tab)
    employmentTax,
    propertyTax,
    savingsTax,
    dividendTax,
    // Legacy aggregate (keeps all callers working without change)
    otherTax,
    otherNet:    otherGross - otherTax,
    pensionNet:  grossDrawdown - pensionTax,
    spNet:       statePension - spTax,
    // Per-type nets
    employmentNet: employment - employmentTax,
    propertyNet:   property   - propertyTax,
    savingsNet:    savings    - savingsTax,
    dividendNet:   dividends  - dividendTax,
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

export function calcOtherIncomesNet(incomes, inflFactor, ageCtx) {
  let grossTotal = 0;
  const byType = { employment: 0, property: 0, savings: 0, dividends: 0 };
  const items = incomes.map(inc => {
    const annualAmt = inc.frequency === 'monthly' ? inc.amount * 12 : inc.amount;
    if (ageCtx && inc.incomePeriod) {
      const effectiveStart = inc.startAge ? Math.max(inc.startAge, ageCtx.retirementAge) : ageCtx.retirementAge;
      const effectiveEnd = inc.endAge ? inc.endAge : Infinity;
      if (ageCtx.currentAge < effectiveStart || ageCtx.currentAge > effectiveEnd) {
        return { name: inc.name, gross: 0, tax: 0, net: 0, type: inc.incomeType || 'employment' };
      }
    }
    let gross;
    if (!inc.inflationLinked) {
      gross = annualAmt;
    } else if (inc.inflationBase === 'nominal' && ageCtx) {
      const todayAge = ageCtx.retirementAge - ageCtx.yearsToRetirement;
      const effectiveStart = (inc.incomePeriod && inc.startAge) ? Math.max(inc.startAge, ageCtx.retirementAge) : ageCtx.retirementAge;
      const yearsFromTodayToStart = Math.max(0, effectiveStart - todayAge);
      const inflFactorToStart = Math.pow(ageCtx.baseInflFactor, yearsFromTodayToStart);
      gross = annualAmt * (inflFactor / inflFactorToStart);
    } else {
      gross = annualAmt * inflFactor;
    }
    grossTotal += gross;
    const type = inc.incomeType || 'employment';
    if (type in byType) byType[type] += gross; else byType.employment += gross;
    return { name: inc.name, gross, tax: 0, net: gross, type };
  });
  return { grossTotal, taxTotal: 0, netTotal: grossTotal, items, byType };
}

/**
 * Computes gross DB (defined benefit) pension income for a person in a simulation year.
 * DB pension income is treated as employment income for tax purposes.
 * Amounts are expressed in today's money and inflated by ciFromNow.
 *
 * @param {Array}  dbPensions  array of { id, name, startAge, preSpAnnual, postSpAnnual }
 * @param {number} spAge       state pension age (selects pre vs post SP amount)
 * @param {number} age         person's age in this simulation year
 * @param {number} ciFromNow   cumulative inflation factor from today to this year
 */
export function calcDbIncome(dbPensions, spAge, age, ciFromNow) {
  if (!dbPensions?.length) return { grossTotal: 0, byType: { employment: 0 }, items: [] };
  const items = [];
  let grossTotal = 0;
  for (const db of dbPensions) {
    if (age < (db.startAge || 0)) continue;
    const annual = age < spAge ? (db.preSpAnnual || 0) : (db.postSpAnnual || 0);
    const gross = annual * ciFromNow;
    if (gross <= 0) continue;
    grossTotal += gross;
    items.push({ name: db.name || 'DB Pension', gross, tax: 0, net: gross, type: 'employment' });
  }
  return { grossTotal, byType: { employment: grossTotal }, items };
}
