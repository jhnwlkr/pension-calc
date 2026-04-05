import { HIST_EQUITY_RETURNS, HIST_BONDS_RETURNS, LSA, FORMER_LTA } from './constants.js';
import { incomeTax, calcPensionTax, calcOtherIncomesNet } from './model.js';
import { randn } from './utils.js';

export function historicalReturn(equityWeight) {
  const idx = Math.floor(Math.random() * HIST_EQUITY_RETURNS.length);
  const eq = HIST_EQUITY_RETURNS[idx];
  const bd = HIST_BONDS_RETURNS[idx];
  return 1 + (equityWeight * eq + (1 - equityWeight) * bd) / 100;
}

export function stochasticInflation(baseInflPct, returnMultiplier) {
  const base = baseInflPct / 100;
  const noise = randn() * 0.008;
  const isCrash = returnMultiplier < 0.90;
  const stagflation = isCrash ? Math.max(0, randn() * 0.012 + 0.010) : 0;
  return Math.max(0.005, base + noise + stagflation);
}

export function targetIncome(age, p, cumulInfl) {
  const reductionFactor = age >= p.reductionAge ? (1 - p.reductionPct / 100) : 1.0;
  const inflFactor = p.drawdownInflation !== false ? cumulInfl : 1.0;
  return p.drawdown * inflFactor * reductionFactor;
}

export function potWithdrawal(age, p, cumulInfl) {
  const stateP = age >= p.spAge ? p.sp * cumulInfl : 0;
  const partnerAge = p.partner ? p.partner.currentAge + (age - p.currentAge) : null;
  const partnerSP = (p.partner && partnerAge >= p.partner.spAge) ? p.partner.sp * cumulInfl : 0;
  return Math.max(0, targetIncome(age, p, cumulInfl) - stateP - partnerSP);
}

export const PCT_LABELS = ['5th', '25th', '50th (Median)', '75th', '95th'];

/**
 * Deterministic projection: grow each pot at a fixed nominal returnPct from today
 * to retirement (applying contributions), then run down through retirement withdrawing
 * target income each year. Returns pot-by-year and cash-by-year arrays aligned with r.ages.
 */
export function runDeterministicProjection(p, returnPct) {
  const years = p.endAge - p.retirementAge;
  if (years <= 0) return null;
  // Use exact fractional age from DOB for precise contribution counting
  const yearsToRetirement = Math.max(0, p.retirementAge - (p.currentAgeFrac ?? p.currentAge));
  const fullYearsToRet = Math.floor(yearsToRetirement);
  const partialYear = yearsToRetirement - fullYearsToRet;
  const baseInflFactor = 1 + p.inflation / 100;

  const partnerPots = p.partner?.pots || [];
  const yearsToPartnerRet = p.partner
    ? Math.max(0, Math.min(p.partner.retirementAge - (p.partner.currentAgeFrac ?? p.partner.currentAge), yearsToRetirement))
    : yearsToRetirement;
  const allPotsConfig = [
    ...p.pots.map(pot => ({ ...pot, contribStopYear: yearsToRetirement })),
    ...partnerPots.map(pot => ({ ...pot, contribStopYear: yearsToPartnerRet })),
  ];

  // --- Per-pot deterministic returns scaled so blended aggregate == returnPct ---
  // Use historical means to establish relative equity/bond expected returns, then
  // scale so the value-weighted blend across all pots equals the user's selected rate.
  const meanEq = HIST_EQUITY_RETURNS.reduce((s, v) => s + v, 0) / HIST_EQUITY_RETURNS.length;
  const meanBd = HIST_BONDS_RETURNS.reduce((s, v) => s + v, 0) / HIST_BONDS_RETURNS.length;
  const potExpected = allPotsConfig.map(pot => {
    const eq = (pot.equityPct ?? 80) / 100;
    return eq * meanEq + (1 - eq) * meanBd;
  });
  const totalStartVal = allPotsConfig.reduce((s, pot) => s + (pot.value || 0), 0);
  const blendedMean = totalStartVal > 0
    ? allPotsConfig.reduce((s, pot, i) => s + (pot.value || 0) / totalStartVal * potExpected[i], 0)
    : potExpected[0] ?? returnPct;
  const scaleFactor = blendedMean > 0 ? returnPct / blendedMean : 1;
  const potRets = allPotsConfig.map((_, i) => 1 + (potExpected[i] * scaleFactor) / 100);

  // --- Pre-retirement: grow each pot at its own equity-adjusted rate ---
  const potValsAtRet = allPotsConfig.map((pot, i) => {
    let val = pot.value;
    const potRet = potRets[i];
    for (let y = 0; y < fullYearsToRet; y++) {
      val = val * potRet + (y < pot.contribStopYear ? (pot.annualContrib || 0) : 0);
    }
    if (partialYear > 0) {
      const partialContrib = fullYearsToRet < pot.contribStopYear ? (pot.annualContrib || 0) * partialYear : 0;
      val = val * Math.pow(potRet, partialYear) + partialContrib;
    }
    return Math.max(0, val);
  });
  const pensionPot = potValsAtRet.reduce((s, v) => s + v, 0);

  // Blended return for retirement drawdown phase — weighted by pot value at retirement
  const retBlended = 1 + (pensionPot > 0
    ? allPotsConfig.reduce((s, _, i) => s + potValsAtRet[i] / pensionPot * (potExpected[i] * scaleFactor) / 100, 0)
    : returnPct / 100);

  // Cash pots pre-retirement
  const allCashPots = [...(p.cashPots || []), ...(p.partner?.cashPots || [])];
  const cashBals = allCashPots.map(cp => {
    const r2 = 1 + cp.interestPct / 100;
    return Math.max(0, cp.value * Math.pow(r2, yearsToRetirement));
  });

  // --- Retirement: year-by-year ---
  const detPotByYear = new Float64Array(years + 1);
  const detCashBalByYear = new Float64Array(years + 1);
  const detCashContribByYear = new Float64Array(years + 1);

  detPotByYear[0] = pensionPot;
  detCashBalByYear[0] = cashBals.reduce((s, v) => s + v, 0);

  for (let y = 0; y < years; y++) {
    const age = p.retirementAge + y;
    const ci = Math.pow(baseInflFactor, y);

    // Cash pot growth
    for (let ci2 = 0; ci2 < cashBals.length; ci2++) {
      cashBals[ci2] *= (1 + allCashPots[ci2].interestPct / 100);
    }

    const combined = detPotByYear[y] + cashBals.reduce((s, v) => s + v, 0);
    if (combined <= 0) {
      detPotByYear[y + 1] = 0;
      detCashBalByYear[y + 1] = 0;
      detCashContribByYear[y] = 0;
      continue;
    }

    // Pension pot grows at blended equity-adjusted rate
    const pensionAfterGrowth = detPotByYear[y] * retBlended;

    // Compute gross withdrawal needed (same logic as MC)
    const hasSP = age >= p.spAge;
    const spNom = hasSP ? p.sp * ci : 0;
    const partnerAge = p.partner ? p.partner.currentAge + (age - p.currentAge) : null;
    const partnerSpNom = (p.partner && partnerAge >= p.partner.spAge) ? p.partner.sp * ci : 0;
    const ciFromNowDet = Math.pow(baseInflFactor, yearsToRetirement + y);
    const partnerRetiredDet = !!(p.partner && partnerAge >= p.partner.retirementAge);
    const otherGrossDet = calcOtherIncomesNet(p.incomes || [], ciFromNowDet).grossTotal;
    const partnerOtherGrossDet = (p.partner?.incomes?.length && partnerRetiredDet)
      ? calcOtherIncomesNet(p.partner.incomes, ciFromNowDet).grossTotal : 0;
    const totalOtherGrossDet = otherGrossDet + partnerOtherGrossDet;
    const inflFactor = p.drawdownInflation ? ci : 1.0;
    const baseTargetDet = p.drawdown * inflFactor;
    const targetNominal = age >= p.reductionAge
      ? Math.max(0, (baseTargetDet + totalOtherGrossDet) * (1 - p.reductionPct / 100) - totalOtherGrossDet)
      : baseTargetDet;
    const grossNeeded = Math.max(0, targetNominal - spNom - partnerSpNom);

    // Use notional tax to work out net target (same pattern as MC)
    const notionalTc = calcPensionTax(grossNeeded, spNom, hasSP, p.taxFreeFrac || 0.25);
    const netTarget = notionalTc.pensionNet;

    // Draw from cash pots first
    let cashRemaining = netTarget;
    for (let ci2 = 0; ci2 < cashBals.length && cashRemaining > 0; ci2++) {
      const take = Math.min(cashBals[ci2], cashRemaining);
      cashBals[ci2] -= take;
      cashRemaining -= take;
    }
    const cashTaken = netTarget - cashRemaining;

    // Gross up remaining net from pension
    const remainingNet = Math.max(0, netTarget - cashTaken);
    const pensionWithdrawal = netTarget > 0 ? remainingNet * (grossNeeded / netTarget) : 0;

    detCashContribByYear[y] = cashTaken;
    detPotByYear[y + 1] = Math.max(0, pensionAfterGrowth - pensionWithdrawal);
    detCashBalByYear[y + 1] = cashBals.reduce((s, v) => s + v, 0);
  }
  detCashContribByYear[years] = 0;

  return { detPotByYear, detCashBalByYear, detCashContribByYear };
}

export function buildAnnualIncomeData(r, pctileIdx) {
  const p = r.p;
  const baseInflFactor = 1 + p.inflation / 100;
  const yearsToRetirement = Math.max(0, p.retirementAge - p.currentAge);
  const currentYear = new Date().getFullYear();
  const startPensionPot = r.startPensionPot || r.startPot;

  const cashBals = r.startCashPotVals ? Float64Array.from(r.startCashPotVals) : new Float64Array(0);
  // Per-person LSA tracking: 25% tax-free each year until £268,275 is used up
  const primaryPotFrac_ = r.primaryPotFrac ?? 1.0;
  let cumulPrimaryTaxFree = 0;
  let cumulPartnerTaxFree = 0;
  const result = [];
  for (let yi = 0; yi < r.ages.length; yi++) {
    const age = r.ages[yi];
    const hasStatePension = age >= p.spAge;
    const ci = Math.pow(baseInflFactor, yi);
    const ciFromNow = Math.pow(baseInflFactor, yearsToRetirement + yi);
    const todayDeflator = Math.pow(1 / baseInflFactor, yearsToRetirement + yi);

    const combinedDet = (r.detPotByYear?.[yi] ?? 0) + (r.detCashBalByYear?.[yi] ?? 0);
    const cashAtYear = r.detCashBalByYear?.[yi] ?? (r.cashBalByYear ? r.cashBalByYear[yi] : 0);
    const pensionAtPctile = r.detPotByYear?.[yi] ?? 0;
    const potDepleted = combinedDet <= 0;

    const guardrailActive = p.guardrails && yi > 0 && !potDepleted && pensionAtPctile < startPensionPot * 0.80;
    const guardrailFactor = guardrailActive ? 0.90 : 1.0;

    // p.sp and p.partner.sp are both pre-inflated to retirement; multiply by ci
    const spInflated = hasStatePension ? p.sp * ci : 0;
    const partnerAge = p.partner ? p.partner.currentAge + (age - p.currentAge) : null;
    const hasPartnerSP = !!(p.partner && partnerAge >= p.partner.spAge);
    const partnerSpInflated = hasPartnerSP ? p.partner.sp * ci : 0;

    for (let ci2 = 0; ci2 < (p.cashPots || []).length; ci2++) {
      cashBals[ci2] *= (1 + p.cashPots[ci2].interestPct / 100);
    }

    const otherNet = calcOtherIncomesNet(p.incomes, ciFromNow);
    const partnerRetiredAID = !!(p.partner && partnerAge >= p.partner.retirementAge);
    const partnerOtherAID = (p.partner?.incomes?.length && partnerRetiredAID)
      ? calcOtherIncomesNet(p.partner.incomes, ciFromNow) : { grossTotal: 0, taxTotal: 0, netTotal: 0 };
    // Reduction applies to total gross income (drawdown target + other incomes combined).
    // Only the drawdown target can be cut; other incomes are fixed. Floor at 0.
    const inflFactor = p.drawdownInflation ? ci : 1.0;
    const baseTarget = p.drawdown * inflFactor;
    const totalOtherGross = otherNet.grossTotal + partnerOtherAID.grossTotal;
    const targetNominal = age >= p.reductionAge
      ? Math.max(0, (baseTarget + totalOtherGross) * (1 - p.reductionPct / 100) - totalOtherGross)
      : baseTarget;
    const neededFromPots = Math.max(0, targetNominal - spInflated - partnerSpInflated);

    const notionalTcAnn = calcPensionTax(neededFromPots, spInflated, hasStatePension, r.taxFreeFrac, otherNet.grossTotal);
    const netTargetAnn = notionalTcAnn.pensionNet;
    let cashContrib = 0;
    for (let ci2 = 0; ci2 < cashBals.length && cashContrib < netTargetAnn; ci2++) {
      const take = Math.min(cashBals[ci2], netTargetAnn - cashContrib);
      cashBals[ci2] -= take;
      cashContrib += take;
    }

    const remainingNetAnn = Math.max(0, netTargetAnn - cashContrib);
    const intendedPensionWithdrawal = netTargetAnn > 0
      ? remainingNetAnn * (neededFromPots / netTargetAnn) * guardrailFactor
      : 0;
    const potWithdrawNominal = potDepleted ? 0 : Math.min(pensionAtPctile, intendedPensionWithdrawal);

    // Per-year tax-free fracs: 25% until each person's LSA (£268,275) is exhausted, then 0%
    const actualPriDraw = potWithdrawNominal * primaryPotFrac_;
    const actualParDraw = potWithdrawNominal * (1 - primaryPotFrac_);
    const primaryTFracYear = actualPriDraw > 0
      ? Math.min(0.25, Math.max(0, LSA - cumulPrimaryTaxFree) / actualPriDraw)
      : (cumulPrimaryTaxFree < LSA ? 0.25 : 0);
    const partnerTFracYear = (p.partner && actualParDraw > 0)
      ? Math.min(0.25, Math.max(0, LSA - cumulPartnerTaxFree) / actualParDraw)
      : 0.25;
    const taxFreeFracYear = potWithdrawNominal > 0
      ? (actualPriDraw * primaryTFracYear + actualParDraw * partnerTFracYear) / potWithdrawNominal
      : 0.25;
    const tc = calcPensionTax(potWithdrawNominal, spInflated, hasStatePension, taxFreeFracYear, otherNet.grossTotal);
    cumulPrimaryTaxFree = Math.min(LSA, cumulPrimaryTaxFree + actualPriDraw * primaryTFracYear);
    if (p.partner) cumulPartnerTaxFree = Math.min(LSA, cumulPartnerTaxFree + actualParDraw * partnerTFracYear);
    const totalNetNominal = cashContrib + tc.pensionNet + (hasStatePension ? tc.spNet : 0) + partnerSpInflated + tc.otherNet + partnerOtherAID.netTotal;

    const potBalNom = pensionAtPctile;
    const potBalReal = pensionAtPctile * todayDeflator;

    const withdrawalNom = cashContrib + potWithdrawNominal;
    const withdrawalReal = withdrawalNom * todayDeflator;

    const prevCombined = yi === 0 ? r.startPot : (r.detPotByYear?.[yi - 1] ?? 0) + (r.detCashBalByYear?.[yi - 1] ?? 0);
    const prevCashBal = yi === 0 ? (r.startCashTotal || 0) : (r.detCashBalByYear?.[yi - 1] ?? (r.cashBalByYear ? r.cashBalByYear[yi - 1] : 0));
    const prevPension = Math.max(0, prevCombined - prevCashBal);
    const pensionInitialValues = r.startInitialPotValues ?? p.pots.reduce((s, pot) => s + pot.value, 0);
    const growthNom = potDepleted ? 0 : yi === 0
      ? (yearsToRetirement > 0 ? r.startPensionPot - pensionInitialValues : 0)
      : pensionAtPctile - prevPension + potWithdrawNominal;
    const growthReal = growthNom * todayDeflator;

    const netPotChangeNom = potDepleted ? 0 : yi === 0 ? 0 : pensionAtPctile - prevPension;
    const netPotChangeReal = netPotChangeNom * todayDeflator;

    result.push({
      age,
      calYear: currentYear + (age - p.currentAge),
      cashNom: cashContrib / 12,
      cashReal: (cashContrib * todayDeflator) / 12,
      pensionNom: tc.pensionNet / 12,
      // SP: show gross as headline so both SP columns are directly comparable
      spNom: spInflated / 12,
      spReal: (spInflated * todayDeflator) / 12,
      otherNom: tc.otherNet / 12,
      netNom: totalNetNominal / 12,
      pensionReal: (tc.pensionNet * todayDeflator) / 12,
      otherReal: (tc.otherNet * todayDeflator) / 12,
      netReal: (totalNetNominal * todayDeflator) / 12,
      // Gross/tax breakdown for income column sub-lines
      pensionGrossNom: potWithdrawNominal / 12,
      pensionTaxNom: tc.pensionTax / 12,
      pensionGrossReal: (potWithdrawNominal * todayDeflator) / 12,
      pensionTaxReal: (tc.pensionTax * todayDeflator) / 12,
      spGrossNom: spInflated / 12,
      spTaxNom: hasStatePension ? tc.spTax / 12 : 0,
      spGrossReal: (spInflated * todayDeflator) / 12,
      spTaxReal: hasStatePension ? (tc.spTax * todayDeflator) / 12 : 0,
      partnerSpNom: partnerSpInflated / 12,
      partnerSpReal: (partnerSpInflated * todayDeflator) / 12,
      partnerSpGrossNom: partnerSpInflated / 12,
      partnerSpGrossReal: (partnerSpInflated * todayDeflator) / 12,
      otherGrossNom: otherNet.grossTotal / 12,
      otherTaxNom: tc.otherTax / 12,
      otherGrossReal: (otherNet.grossTotal * todayDeflator) / 12,
      otherTaxReal: (tc.otherTax * todayDeflator) / 12,
      netGrossNom: (cashContrib + potWithdrawNominal + spInflated + partnerSpInflated + otherNet.grossTotal + partnerOtherAID.grossTotal) / 12,
      netTaxNom: (tc.pensionTax + (hasStatePension ? tc.spTax : 0) + tc.otherTax + partnerOtherAID.taxTotal) / 12,
      netGrossReal: ((cashContrib + potWithdrawNominal + spInflated + partnerSpInflated + otherNet.grossTotal + partnerOtherAID.grossTotal) * todayDeflator) / 12,
      netTaxReal: ((tc.pensionTax + (hasStatePension ? tc.spTax : 0) + tc.otherTax + partnerOtherAID.taxTotal) * todayDeflator) / 12,
      pensionWithdrawalNom: potWithdrawNominal,
      pensionWithdrawalReal: potWithdrawNominal * todayDeflator,
      cashWithdrawalNom: cashContrib,
      cashWithdrawalReal: cashContrib * todayDeflator,
      potBalNom,
      potBalReal,
      withdrawalNom,
      withdrawalReal,
      growthNom,
      growthReal,
      netPotChangeNom,
      netPotChangeReal,
      partnerAge,
      primaryTaxFreeFracAnn: primaryTFracYear,
      partnerTaxFreeFracAnn: partnerTFracYear,
      guardrailActive,
      isSpStart: age === p.spAge,
      isPartnerSpStart: !!(p.partner && partnerAge === p.partner.spAge),
      isReductionStart: age === p.reductionAge,
    });
  }
  return result;
}

export function runSimulation(p) {
  const years = p.endAge - p.retirementAge;
  if (years <= 0) return null;
  const ages = Array.from({ length: years + 1 }, (_, i) => p.retirementAge + i);
  const nRuns = p.runs;

  const yearsToRetirement = Math.max(0, p.retirementAge - (p.currentAgeFrac ?? p.currentAge));
  const fullYearsToRet = Math.floor(yearsToRetirement);
  const partialYear = yearsToRetirement - fullYearsToRet;

  // Partner pots: contributions stop at partner.retirementAge; then pure growth to primary retirement
  const partnerPots = p.partner?.pots || [];
  const yearsToPartnerRet = p.partner
    ? Math.max(0, Math.min(p.partner.retirementAge - (p.partner.currentAgeFrac ?? p.partner.currentAge), yearsToRetirement))
    : yearsToRetirement;
  const numPrimaryPots = p.pots.length;
  // Merged pots: primary (contributions all the way) then partner (contributions stop at partner retirement)
  const allPotsConfig = [
    ...p.pots.map(pot => ({ ...pot, contribStopYear: yearsToRetirement })),
    ...partnerPots.map(pot => ({ ...pot, contribStopYear: yearsToPartnerRet })),
  ];
  const numPots = allPotsConfig.length;
  const startPotsPerRun = Array.from({ length: nRuns }, () => new Float64Array(numPots));

  if (yearsToRetirement === 0) {
    for (let r = 0; r < nRuns; r++) {
      allPotsConfig.forEach((pot, pi) => { startPotsPerRun[r][pi] = Math.max(0, pot.value); });
    }
  } else {
    for (let r = 0; r < nRuns; r++) {
      allPotsConfig.forEach((pot, pi) => {
        let val = pot.value;
        const eq = (pot.equityPct || 80) / 100;
        for (let y = 0; y < fullYearsToRet; y++) {
          val = val * historicalReturn(eq) + (y < pot.contribStopYear ? (pot.annualContrib || 0) : 0);
        }
        // Partial final year: deterministic return for fraction + prorated contribution
        if (partialYear > 0) {
          const partialContrib = fullYearsToRet < pot.contribStopYear ? (pot.annualContrib || 0) * partialYear : 0;
          // Use the expected return (not random) for sub-year remainder to avoid noise
          const partialRet = 1 + ((eq * 5.5 + (1 - eq) * 2.5) / 100); // ~blended expected
          val = val * Math.pow(partialRet, partialYear) + partialContrib;
        }
        startPotsPerRun[r][pi] = Math.max(0, val);
      });
    }
  }

  // Combined cash pots (primary + partner)
  const allCashPots = [...(p.cashPots || []), ...(p.partner?.cashPots || [])];
  const numCashPots = allCashPots.length;
  const startCashPotVals = new Float64Array(numCashPots);
  allCashPots.forEach((cp, ci) => {
    const rate = 1 + cp.interestPct / 100;
    startCashPotVals[ci] = Math.max(0, cp.value * Math.pow(rate, yearsToRetirement));
  });

  const startTotals = new Float64Array(nRuns);
  for (let r = 0; r < nRuns; r++) {
    let tot = 0;
    for (let pi = 0; pi < numPots; pi++) tot += startPotsPerRun[r][pi];
    startTotals[r] = tot;
  }
  // Separate primary / partner medians for per-person LSA calc
  const primaryStartTotals = new Float64Array(nRuns);
  const partnerStartTotals = new Float64Array(nRuns);
  for (let r = 0; r < nRuns; r++) {
    let pt = 0; for (let pi = 0; pi < numPrimaryPots; pi++) pt += startPotsPerRun[r][pi];
    let pp = 0; for (let pi = numPrimaryPots; pi < numPots; pi++) pp += startPotsPerRun[r][pi];
    primaryStartTotals[r] = pt;
    partnerStartTotals[r] = pp;
  }
  const sortedSP = Float64Array.from(startTotals).sort();
  const startPensionPot = sortedSP[Math.floor(nRuns / 2)];
  const startCashTotal = startCashPotVals.reduce((s, v) => s + v, 0);
  const startPot = startPensionPot + startCashTotal;

  const effectiveDrawdown = p.drawdownMode === 'pct'
    ? startPot * p.drawdownPct / 100
    : p.drawdown;
  // Inflate state pension from today to retirement so it correctly grows with
  // triple-lock inflation through the pre-retirement years, not just from retirement.
  const spAtRetirement = p.sp * Math.pow(1 + p.inflation / 100, yearsToRetirement);
  const partnerSpAtRetirement = p.partner ? p.partner.sp * Math.pow(1 + p.inflation / 100, yearsToRetirement) : null;
  p = Object.assign({}, p, {
    drawdown: effectiveDrawdown,
    sp: spAtRetirement,
    cashPots: allCashPots,
    ...(p.partner ? { partner: Object.assign({}, p.partner, { sp: partnerSpAtRetirement }) } : {}),
  });

  // Each person's pot gets its own LSA (£268,275) — compute weighted combined tax-free fraction
  const primaryPotMedian = Float64Array.from(primaryStartTotals).sort()[Math.floor(nRuns / 2)];
  const partnerPotMedian = Float64Array.from(partnerStartTotals).sort()[Math.floor(nRuns / 2)];
  const primaryTaxFreeAmt = primaryPotMedian > 0 ? primaryPotMedian * Math.min(0.25, LSA / primaryPotMedian) : 0;
  const partnerTaxFreeAmt = partnerPotMedian > 0 ? partnerPotMedian * Math.min(0.25, LSA / partnerPotMedian) : 0;
  const taxFreeFrac = startPensionPot > 0 ? (primaryTaxFreeAmt + partnerTaxFreeAmt) / startPensionPot : 0.25;
  // Per-person fractions exported so Tax Breakdown can tax each person independently
  const primaryTaxFreeFrac = primaryPotMedian > 0 ? Math.min(0.25, LSA / primaryPotMedian) : 0.25;
  const partnerTaxFreeFrac = partnerPotMedian > 0 ? Math.min(0.25, LSA / partnerPotMedian) : 0.25;
  const primaryPotFrac = (primaryPotMedian + partnerPotMedian) > 0
    ? primaryPotMedian / (primaryPotMedian + partnerPotMedian)
    : 1.0;

  const potsOrder = allPotsConfig.map((_, idx) => idx).sort((a, b) => (allPotsConfig[a].equityPct || 80) - (allPotsConfig[b].equityPct || 80));

  const medianPotVals = allPotsConfig.map((_, pi) => {
    const vals = Array.from({ length: nRuns }, (_, r) => startPotsPerRun[r][pi]).sort((a, b) => a - b);
    return vals[Math.floor(nRuns / 2)];
  });
  const totalMedianVal = medianPotVals.reduce((s, v) => s + v, 0);
  const weightedEquityW = totalMedianVal > 0
    ? allPotsConfig.reduce((s, pot, pi) => s + (medianPotVals[pi] / totalMedianVal) * ((pot.equityPct || 80) / 100), 0)
    : (allPotsConfig[0]?.equityPct || 80) / 100;

  const potMatrix = Array.from({ length: nRuns }, () => new Float64Array(years + 1));
  const yearIdxMatrix = Array.from({ length: nRuns }, () => new Uint8Array(years));
  const blendedRetMatrix = Array.from({ length: nRuns }, () => new Float32Array(years));
  let successCount = 0;
  let guardrailTriggerCount = 0;

  for (let r = 0; r < nRuns; r++) {
    const runPots = new Float64Array(numPots);
    potsOrder.forEach((origIdx, rank) => { runPots[rank] = startPotsPerRun[r][origIdx]; });

    const runCashPots = Float64Array.from(startCashPotVals);
    const runStartValues = Float64Array.from(runPots);
    let cumulInfl = 1.0;
    potMatrix[r][0] = runCashPots.reduce((s, v) => s + v, 0) + runPots.reduce((s, v) => s + v, 0);
    let guardrailEverTriggered = false;

    for (let y = 0; y < years; y++) {
      const age = p.retirementAge + y;
      const cashTotal = runCashPots.reduce((s, v) => s + v, 0);
      const pensionTotal = runPots.reduce((s, v) => s + v, 0);
      const runTotal = cashTotal + pensionTotal;

      if (runTotal <= 0) {
        potMatrix[r][y + 1] = 0;
        cumulInfl *= (1 + p.inflation / 100);
        continue;
      }

      // cash growth
      for (let ci = 0; ci < numCashPots; ci++) {
        runCashPots[ci] *= (1 + p.cashPots[ci].interestPct / 100);
      }

      const yearIdx = Math.floor(Math.random() * HIST_EQUITY_RETURNS.length);
      const eqRetYear = HIST_EQUITY_RETURNS[yearIdx];
      const bdRetYear = HIST_BONDS_RETURNS[yearIdx];

      let blendedRet = 0;
      const totalForBlend = runPots.reduce((s, v) => s + v, 0);
      for (let rank = 0; rank < numPots; rank++) {
        const origIdx = potsOrder[rank];
        const eq = (allPotsConfig[origIdx].equityPct || 80) / 100;
        const ret = 1 + (eq * eqRetYear + (1 - eq) * bdRetYear) / 100;
        const w = totalForBlend > 0 ? runPots[rank] / totalForBlend : 1 / numPots;
        blendedRet += w * ret;
        runPots[rank] = runPots[rank] * ret;
      }
      yearIdxMatrix[r][y] = yearIdx;
      blendedRetMatrix[r][y] = (blendedRet - 1) * 100;

      const inflThisYear = stochasticInflation(p.inflation, blendedRet);
      cumulInfl *= (1 + inflThisYear);
      const pensionTotalAfterGrowth = runPots.reduce((s, v) => s + v, 0);

      const pensionOnlyStart = startTotals[r];
      const guardrailActive = p.guardrails && pensionTotalAfterGrowth < pensionOnlyStart * 0.80;
      if (guardrailActive) guardrailEverTriggered = true;

      const hasSPthisYear = age >= p.spAge;
      const spNomMC = hasSPthisYear ? p.sp * cumulInfl : 0;
      const partnerAgeMC = p.partner ? p.partner.currentAge + (age - p.currentAge) : null;
      const partnerSpNomMC = (p.partner && partnerAgeMC >= p.partner.spAge) ? p.partner.sp * cumulInfl : 0;
      // Use base inflation for pre-retirement portion; stochastic cumulInfl from retirement onward
      const ciMCFromNow = Math.pow(1 + p.inflation / 100, yearsToRetirement) * cumulInfl;
      const partnerRetiredMC = !!(p.partner && partnerAgeMC >= p.partner.retirementAge);
      const otherGrossMC = calcOtherIncomesNet(p.incomes || [], ciMCFromNow).grossTotal;
      const partnerOtherGrossMC = (p.partner?.incomes?.length && partnerRetiredMC)
        ? calcOtherIncomesNet(p.partner.incomes, ciMCFromNow).grossTotal : 0;
      const totalOtherGrossMC = otherGrossMC + partnerOtherGrossMC;
      const inflFactor = p.drawdownInflation ? cumulInfl : 1.0;
      const baseTargetMC = p.drawdown * inflFactor;
      const targetNominal = age >= p.reductionAge
        ? Math.max(0, (baseTargetMC + totalOtherGrossMC) * (1 - p.reductionPct / 100) - totalOtherGrossMC)
        : baseTargetMC;
      const grossWithdrawal = Math.max(0, targetNominal - spNomMC - partnerSpNomMC);

      const notionalTc = calcPensionTax(grossWithdrawal, spNomMC, hasSPthisYear, taxFreeFrac);
      const netTarget = notionalTc.pensionNet;
      let cashRemaining = netTarget;
      for (let ci = 0; ci < numCashPots && cashRemaining > 0; ci++) {
        const take = Math.min(runCashPots[ci], cashRemaining);
        runCashPots[ci] -= take;
        cashRemaining -= take;
      }
      const cashTaken = netTarget - cashRemaining;

      const guardrailFactor = guardrailActive ? 0.90 : 1.0;
      const remainingNet = Math.max(0, netTarget - cashTaken);
      let pensionWithdrawal = netTarget > 0
        ? remainingNet * (grossWithdrawal / netTarget) * guardrailFactor
        : 0;
      for (let rank = 0; rank < numPots && pensionWithdrawal > 0; rank++) {
        const take = Math.min(runPots[rank], pensionWithdrawal);
        runPots[rank] -= take;
        pensionWithdrawal -= take;
      }

      for (let rank = 0; rank < numPots - 1; rank++) {
        if (runPots[rank] < runStartValues[rank] * 0.5) {
          const deficit = runStartValues[rank] - runPots[rank];
          const nextRank = rank + 1;
          if (nextRank < numPots && runPots[nextRank] > 0) {
            const transfer = Math.min(deficit, runPots[nextRank]);
            runPots[rank] += transfer;
            runPots[nextRank] -= transfer;
          }
        }
      }

      const newCashTotal = runCashPots.reduce((s, v) => s + v, 0);
      const newPensionTotal = runPots.reduce((s, v) => s + v, 0);
      potMatrix[r][y + 1] = Math.max(0, newCashTotal + newPensionTotal);
    }

    if (potMatrix[r][years] > 0) successCount++;
    if (guardrailEverTriggered) guardrailTriggerCount++;
  }

  const pctiles = [5, 25, 50, 75, 95];
  const percentileData = pctiles.map(() => new Float64Array(years + 1));
  for (let y = 0; y <= years; y++) {
    const vals = Array.from({ length: nRuns }, (_, r) => potMatrix[r][y]).sort((a, b) => a - b);
    pctiles.forEach((pc, pi) => {
      const idx = Math.floor((pc / 100) * (nRuns - 1));
      percentileData[pi][y] = vals[idx];
    });
  }

  // Representative run per percentile for MC sequence table (includes 1st percentile)
  const mcPctiles = [1, 5, 25, 50, 75, 95];
  const midYear = Math.floor(years / 2);
  const midYearVals = Array.from({ length: nRuns }, (_, rr) => potMatrix[rr][midYear]).sort((a, b) => a - b);
  const mcRepPaths = mcPctiles.map(pc => {
    const target = midYearVals[Math.min(nRuns - 1, Math.floor((pc / 100) * (nRuns - 1)))];
    let bestRun = 0, bestDiff = Infinity;
    for (let run = 0; run < nRuns; run++) {
      const diff = Math.abs(potMatrix[run][midYear] - target);
      if (diff < bestDiff) { bestDiff = diff; bestRun = run; }
    }
    return {
      balances: Float64Array.from(potMatrix[bestRun]),
      histYears: Array.from(yearIdxMatrix[bestRun]).map(idx => 1900 + idx),
      grossReturns: Array.from(blendedRetMatrix[bestRun]),
    };
  });

  const prob = (successCount / nRuns) * 100;
  const guardrailPct = (guardrailTriggerCount / nRuns) * 100;
  const baseInflFactor = 1 + p.inflation / 100;
  const realDeflatorRetirement = Math.pow(1 / baseInflFactor, yearsToRetirement);
  // Median pot at target (retirement) age, adjusted to today's money
  const medianReal = percentileData[2][0] * realDeflatorRetirement;

  function successRateForTarget(dd, runs400) {
    const pp = Object.assign({}, p, { drawdown: dd });
    let sc = 0;
    const inflF = 1 + p.inflation / 100;
    for (let r = 0; r < runs400; r++) {
      let pot2 = startPot;
      for (let y = 0; y < years; y++) {
        const age = p.retirementAge + y;
        const ci = Math.pow(inflF, y);
        const w = potWithdrawal(age, pp, ci);
        if (pot2 <= 0) { pot2 = 0; break; }
        pot2 = pot2 * historicalReturn(weightedEquityW) - w;
        if (pot2 < 0) { pot2 = 0; break; }
      }
      if (pot2 > 0) sc++;
    }
    return sc / runs400 * 100;
  }

  let lo = 0, hi = startPot * 0.2, swr = 0;
  for (let i = 0; i < 15; i++) {
    const mid = (lo + hi) / 2;
    if (successRateForTarget(mid, Math.min(nRuns, 400)) >= 95) { swr = mid; lo = mid; }
    else hi = mid;
  }
  const swrPct = startPot > 0 ? (swr / startPot) * 100 : 0;

  let netMonthly = 0, taxCalc = null;

  const swrByAge = [];
  for (let startAge = p.retirementAge; startAge <= Math.min(p.retirementAge + 20, p.endAge - 5); startAge += 5) {
    const yrs = p.endAge - startAge;
    if (yrs <= 0) continue;
    let lo2 = 0, hi2 = startPot * 0.2, swr2 = 0;
    const inflF = 1 + p.inflation / 100;
    for (let i = 0; i < 12; i++) {
      const mid = (lo2 + hi2) / 2;
      const pp2 = Object.assign({}, p, { drawdown: mid, retirementAge: startAge });
      let sc3 = 0;
      for (let r = 0; r < 200; r++) {
        let pot3 = startPot;
        for (let y = 0; y < yrs; y++) {
          const ci = Math.pow(inflF, y);
          const w = potWithdrawal(startAge + y, pp2, ci);
          if (pot3 <= 0) { pot3 = 0; break; }
          pot3 = pot3 * historicalReturn(weightedEquityW) - w;
          if (pot3 < 0) { pot3 = 0; break; }
        }
        if (pot3 > 0) sc3++;
      }
      if (sc3 / 200 * 100 >= 95) { swr2 = mid; lo2 = mid; } else hi2 = mid;
    }
    swrByAge.push({ age: startAge, swr: swr2, pct: startPot > 0 ? (swr2 / startPot) * 100 : 0 });
  }

  const survivalByAge = ages.map((age, yi) => {
    let alive = 0;
    for (let r = 0; r < nRuns; r++) { if (potMatrix[r][yi] > 0) alive++; }
    return alive / nRuns * 100;
  });

  const cashContribByYear = new Float64Array(years + 1);
  const cashBalByYear = new Float64Array(years + 1);
  {
    const cb = Float64Array.from(startCashPotVals);
    cashBalByYear[0] = cb.reduce((s, v) => s + v, 0);
    const inflF = 1 + p.inflation / 100;
    for (let y = 0; y < years; y++) {
      const age = p.retirementAge + y;
      for (let ci = 0; ci < numCashPots; ci++) cb[ci] *= (1 + p.cashPots[ci].interestPct / 100);
      const inflFactor = p.drawdownInflation ? Math.pow(inflF, y) : 1.0;
      const hasSP = age >= p.spAge;
      const spNomDet = hasSP ? p.sp * Math.pow(inflF, y) : 0;
      const partnerAgeDet = p.partner ? p.partner.currentAge + (age - p.currentAge) : null;
      const partnerSpNomDet = (p.partner && partnerAgeDet >= p.partner.spAge) ? p.partner.sp * Math.pow(inflF, y) : 0;
      const ciCashFromNow = Math.pow(inflF, yearsToRetirement + y);
      const partnerRetiredCash = !!(p.partner && partnerAgeDet >= p.partner.retirementAge);
      const otherGrossCash = calcOtherIncomesNet(p.incomes || [], ciCashFromNow).grossTotal;
      const partnerOtherGrossCash = (p.partner?.incomes?.length && partnerRetiredCash)
        ? calcOtherIncomesNet(p.partner.incomes, ciCashFromNow).grossTotal : 0;
      const baseTargetCash = p.drawdown * inflFactor;
      const totalOtherGrossCash = otherGrossCash + partnerOtherGrossCash;
      const adjustedTargetCash = age >= p.reductionAge
        ? Math.max(0, (baseTargetCash + totalOtherGrossCash) * (1 - p.reductionPct / 100) - totalOtherGrossCash)
        : baseTargetCash;
      const grossNeeded = Math.max(0, adjustedTargetCash - spNomDet - partnerSpNomDet);
      const ntc = calcPensionTax(grossNeeded, spNomDet, hasSP, taxFreeFrac);
      const netTarget = ntc.pensionNet;
      let remaining = netTarget;
      for (let ci = 0; ci < numCashPots && remaining > 0; ci++) {
        const take = Math.min(cb[ci], remaining); cb[ci] -= take; remaining -= take;
      }
      cashContribByYear[y] = netTarget - remaining;
      cashBalByYear[y + 1] = cb.reduce((s, v) => s + v, 0);
    }
    if (years > 0) cashContribByYear[years] = 0;
  }

  // Compute det projection first; if drawdown is pct-based, rebase the absolute amount on the
  // det pot rather than the MC median pot so netMonthly/income charts reflect selected return %
  const returnPct = p.returnPct ?? 5;
  let det = runDeterministicProjection(Object.assign({}, p, { taxFreeFrac }), returnPct);
  if (p.drawdownMode === 'pct' && det) {
    const detTotalAtRet = (det.detPotByYear[0] ?? 0) + (det.detCashBalByYear[0] ?? 0);
    p = Object.assign({}, p, { drawdown: detTotalAtRet * (p.drawdownPct || 0) / 100 });
    det = runDeterministicProjection(Object.assign({}, p, { taxFreeFrac }), returnPct);
  }

  const hasSpAtRetirement = p.retirementAge >= p.spAge;
  const partnerAgeAtRet = p.partner ? p.partner.currentAge + (p.retirementAge - p.currentAge) : null;
  const partnerSpAtRet = (p.partner && partnerAgeAtRet >= p.partner.spAge) ? p.partner.sp : 0;
  const partnerRetiredAtRet = !!(p.partner && partnerAgeAtRet >= p.partner.retirementAge);
  const cashAtRetirement = cashContribByYear[0] || 0;
  const grossNeededRet = potWithdrawal(p.retirementAge, p, 1.0);
  const potWAtRetirement = pensionGrossAfterCash(grossNeededRet, cashAtRetirement, hasSpAtRetirement);
  const otherAtRetirement = calcOtherIncomesNet(p.incomes, Math.pow(baseInflFactor, yearsToRetirement));
  const partnerOtherAtRet = (partnerRetiredAtRet && p.partner.incomes?.length)
    ? calcOtherIncomesNet(p.partner.incomes, Math.pow(baseInflFactor, yearsToRetirement))
    : { netTotal: 0, grossTotal: 0 };
  taxCalc = calcPensionTax(potWAtRetirement, hasSpAtRetirement ? p.sp : 0, hasSpAtRetirement, taxFreeFrac, otherAtRetirement.grossTotal);
  netMonthly = (cashAtRetirement + taxCalc.pensionNet + (hasSpAtRetirement ? taxCalc.spNet : 0) + partnerSpAtRet + taxCalc.otherNet + partnerOtherAtRet.netTotal) / 12;
  const grossMonthly = (cashAtRetirement + potWAtRetirement + (hasSpAtRetirement ? p.sp : 0) + partnerSpAtRet + otherAtRetirement.grossTotal + partnerOtherAtRet.grossTotal) / 12;
  const netAnnual = netMonthly * 12;
  const grossAnnual = grossMonthly * 12;

  function pensionGrossAfterCash(grossNeeded, cashC, hasSP, spInfl = p.sp) {
    const ntc = calcPensionTax(grossNeeded, spInfl, hasSP, taxFreeFrac);
    const netTarget = ntc.pensionNet;
    const cashUsed = Math.min(cashC, netTarget);
    const remainingNet = Math.max(0, netTarget - cashUsed);
    return netTarget > 0 ? remainingNet * (grossNeeded / netTarget) : 0;
  }

  const realIncomeByAge = ages.map((age, yi) => {
    const hasStatePension = age >= p.spAge;
    const ci = Math.pow(baseInflFactor, yi);
    const ciFromNow = Math.pow(baseInflFactor, yearsToRetirement + yi);
    const spInfl = hasStatePension ? p.sp * ci : 0;
    const otherNet = calcOtherIncomesNet(p.incomes, ciFromNow);
    const cashC = det.detCashContribByYear[yi] || 0;
    // Use deterministic projection to check whether the pension pot is depleted at this year
    const pensionDepleted = det.detPotByYear[yi] <= 0;
    const grossNeeded = potWithdrawal(age, p, ci);
    const potW = pensionDepleted ? 0 : pensionGrossAfterCash(grossNeeded, cashC, hasStatePension, spInfl);
    const tc = calcPensionTax(potW, spInfl, hasStatePension, taxFreeFrac, otherNet.grossTotal);
    const realF = Math.pow(1 / baseInflFactor, yi);
    const partnerAgeRI = p.partner ? p.partner.currentAge + (age - p.currentAge) : null;
    const partnerSpInflRI = (p.partner && partnerAgeRI >= p.partner.spAge) ? p.partner.sp * ci : 0;
    const partnerOtherRI = (p.partner?.incomes?.length && partnerAgeRI >= p.partner.retirementAge)
      ? calcOtherIncomesNet(p.partner.incomes, ciFromNow) : { grossTotal: 0, netTotal: 0 };
    return {
      age,
      gross: (cashC + potW + spInfl + partnerSpInflRI + otherNet.grossTotal + partnerOtherRI.grossTotal) * realF,
      net: (cashC + tc.pensionNet + (hasStatePension ? tc.spNet : 0) + partnerSpInflRI + tc.otherNet + partnerOtherRI.netTotal) * realF
    };
  });

  const netMonthlyByAge = ages.map((age, yi) => {
    const hasStatePension = age >= p.spAge;
    const ci = Math.pow(baseInflFactor, yi);
    const ciFromNow = Math.pow(baseInflFactor, yearsToRetirement + yi);
    const spInfl = hasStatePension ? p.sp * ci : 0;
    const otherNet = calcOtherIncomesNet(p.incomes, ciFromNow);
    const cashC = det.detCashContribByYear[yi] || 0;
    // Use deterministic projection to check whether the pension pot is depleted at this year
    const pensionDepleted = det.detPotByYear[yi] <= 0;
    const grossNeeded = potWithdrawal(age, p, ci);
    const potW = pensionDepleted ? 0 : pensionGrossAfterCash(grossNeeded, cashC, hasStatePension, spInfl);
    const tc = calcPensionTax(potW, spInfl, hasStatePension, taxFreeFrac, otherNet.grossTotal);
    const realF = Math.pow(1 / baseInflFactor, yi);
    const partnerAgeNM = p.partner ? p.partner.currentAge + (age - p.currentAge) : null;
    const partnerSpInflNM = (p.partner && partnerAgeNM >= p.partner.spAge) ? p.partner.sp * ci : 0;
    const partnerOtherNM = (p.partner?.incomes?.length && partnerAgeNM >= p.partner.retirementAge)
      ? calcOtherIncomesNet(p.partner.incomes, ciFromNow) : { netTotal: 0 };
    return {
      age,
      cash: (cashC * realF) / 12,
      pension: (tc.pensionNet * realF) / 12,
      sp: hasStatePension ? (tc.spNet * realF) / 12 : 0,
      partnerSp: (partnerSpInflNM * realF) / 12,
      partnerOther: (partnerOtherNM.netTotal * realF) / 12,
      other: (tc.otherNet * realF) / 12
    };
  });

  const startInitialPotValues = allPotsConfig.reduce((s, pot) => s + (pot.value || 0), 0);

  const result = {
    ages, years, p, prob, guardrailPct, medianReal,
    swrPct, swr, netMonthly, grossMonthly, netAnnual, grossAnnual, startPot, startPensionPot, startCashTotal,
    startCashPotVals, cashContribByYear, cashBalByYear, taxFreeFrac, primaryTaxFreeFrac, partnerTaxFreeFrac, primaryPotFrac, startInitialPotValues,
    percentileData, pctiles, survivalByAge, realIncomeByAge,
    netMonthlyByAge, swrByAge, taxCalc,
    detPotByYear: det.detPotByYear, detCashBalByYear: det.detCashBalByYear, detCashContribByYear: det.detCashContribByYear, returnPct,
    mcRepPaths,
  };
  result.annualIncomeData = buildAnnualIncomeData(result, 2);
  return result;
}
