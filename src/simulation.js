import { HIST_EQUITY_RETURNS, HIST_BONDS_RETURNS, LSA, FORMER_LTA, PA } from './constants.js';
import { incomeTax, calcPensionTax, calcOtherIncomesNet, calcDbIncome } from './model.js';
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

function effectiveEquityPct(pot, age, retirementAge) {
  if (!pot.glideEnabled || !(pot.glideTargetAge > retirementAge)) return pot.equityPct ?? 80;
  if (age >= pot.glideTargetAge) return pot.glideTargetPct ?? 40;
  const t = Math.max(0, (age - retirementAge) / (pot.glideTargetAge - retirementAge));
  return (pot.equityPct ?? 80) * (1 - t) + (pot.glideTargetPct ?? 40) * t;
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

  // --- Per-pot deterministic returns: each pot's rate scales with its equity/bond split.
  // scaleFactor is anchored to the app's default 80% equity split (not value-weighted),
  // so returnPct means "what an 80% equity pot earns". Higher equity pots earn
  // proportionally more; changing one pot's equity never affects other pots' rates.
  const meanEq = HIST_EQUITY_RETURNS.reduce((s, v) => s + v, 0) / HIST_EQUITY_RETURNS.length;
  const meanBd = HIST_BONDS_RETURNS.reduce((s, v) => s + v, 0) / HIST_BONDS_RETURNS.length;
  const baseExpected = 0.8 * meanEq + 0.2 * meanBd; // expected return for 80/20 (app default)
  const scaleFactor = baseExpected > 0 ? returnPct / baseExpected : 1;
  const potRets = allPotsConfig.map(pot => {
    const eq = (pot.equityPct ?? 80) / 100;
    return 1 + (eq * meanEq + (1 - eq) * meanBd) * scaleFactor / 100;
  });

  // --- Pre-retirement: grow each pot at its own equity-adjusted rate ---
  // Also track year-by-year totals for the accumulation chart.
  const accPensionByYear = new Float64Array(fullYearsToRet + 1);
  accPensionByYear[0] = allPotsConfig.reduce((s, pot) => s + (pot.value || 0), 0);
  const potValsAtRet = allPotsConfig.map((pot, i) => {
    let val = pot.value;
    const potRet = potRets[i];
    for (let y = 0; y < fullYearsToRet; y++) {
      val = val * potRet + (y < pot.contribStopYear ? (pot.annualContrib || 0) : 0);
      accPensionByYear[y + 1] = (accPensionByYear[y + 1] || 0) + val;
    }
    if (partialYear > 0) {
      const partialContrib = fullYearsToRet < pot.contribStopYear ? (pot.annualContrib || 0) * partialYear : 0;
      val = val * Math.pow(potRet, partialYear) + partialContrib;
    }
    return Math.max(0, val);
  });
  const pensionPotBeforePcls = potValsAtRet.reduce((s, v) => s + v, 0);

  // PCLS: deduct one-off lump sum from pot at retirement before drawdown begins
  const _priPotDet = potValsAtRet.slice(0, p.pots.length).reduce((s, v) => s + v, 0);
  const _parPotDet = pensionPotBeforePcls - _priPotDet;
  const _priPclsDet = p.taxFreeMode === 'pcls'
    ? Math.min((p.pclsPct || 0) / 100 * _priPotDet, LSA, _priPotDet * 0.25) : 0;
  const _parPclsDet = p.partner?.taxFreeMode === 'pcls'
    ? Math.min((p.partner?.pclsPct || 0) / 100 * _parPotDet, LSA, _parPotDet * 0.25) : 0;
  const pensionPot = Math.max(0, pensionPotBeforePcls - _priPclsDet - _parPclsDet);

  // Blended return for retirement drawdown phase — weighted by pre-PCLS pot values
  const retBlended = 1 + (pensionPotBeforePcls > 0
    ? allPotsConfig.reduce((s, pot, i) => {
        const eq = (pot.equityPct ?? 80) / 100;
        return s + potValsAtRet[i] / pensionPotBeforePcls * (eq * meanEq + (1 - eq) * meanBd) * scaleFactor / 100;
      }, 0)
    : returnPct / 100);

  // Cash pots pre-retirement
  const allCashPots = [
    ...(p.cashPots || []).map(cp => ({ ...cp, _ownerCurrentAge: p.currentAge })),
    ...(p.partner?.cashPots || []).map(cp => ({ ...cp, _ownerCurrentAge: p.partner.currentAge })),
  ];
  const cashBals = allCashPots.map(cp => {
    const cpType = cp.type || 'cash';
    const isML = cpType === 'ss_isa' || cpType === 'lisa';
    if (isML) {
      // S&S ISA / LISA: annual compounding using equity-adjusted scaled return
      const eq = (cp.equityPct || 80) / 100;
      const annualRate = (eq * meanEq + (1 - eq) * meanBd) * scaleFactor / 100;
      const ownerAge = cp._ownerCurrentAge;
      const now = new Date();
      let delayYears = 0;
      if (cp.contribStartMonth) {
        const [cy, cm] = cp.contribStartMonth.split('-').map(Number);
        delayYears = Math.max(0, (cy - now.getFullYear()) * 12 + (cm - 1 - now.getMonth())) / 12;
      }
      const contribYears = Math.max(0, yearsToRetirement - delayYears);
      const annualContrib = (cp.monthlyContrib || 0) * 12;
      let val;
      if (cp.valueFromAge) {
        const yearsUntilArrives = Math.max(0, cp.valueFromAge - ownerAge);
        if (yearsUntilArrives >= yearsToRetirement) {
          val = 0;
        } else {
          const growthYears = yearsToRetirement - yearsUntilArrives;
          val = annualRate > 0 ? cp.value * Math.pow(1 + annualRate, growthYears) : cp.value;
        }
      } else {
        val = annualRate > 0 ? cp.value * Math.pow(1 + annualRate, yearsToRetirement) : cp.value;
      }
      if (annualContrib > 0 && contribYears > 0) {
        val += annualRate > 0
          ? annualContrib * (Math.pow(1 + annualRate, contribYears) - 1) / annualRate
          : annualContrib * contribYears;
      }
      if (cpType === 'lisa' && annualContrib > 0 && ownerAge < 50) {
        const lisaBonus = Math.min(annualContrib, 4000) * 0.25;
        const eligibleYears = Math.max(0, Math.min(contribYears, 50 - ownerAge));
        if (eligibleYears > 0) {
          val += annualRate > 0
            ? lisaBonus * (Math.pow(1 + annualRate, eligibleYears) - 1) / annualRate
            : lisaBonus * eligibleYears;
        }
      }
      return Math.max(0, val);
    } else {
      // Fixed interest: monthly compounding
      const totalMonthsToRet = Math.round(yearsToRetirement * 12);
      const monthlyRate = cp.interestPct / 100 / 12;
      const now = new Date();
      let delayMonths = 0;
      if (cp.contribStartMonth) {
        const [cy, cm] = cp.contribStartMonth.split('-').map(Number);
        delayMonths = Math.max(0, (cy - now.getFullYear()) * 12 + (cm - 1 - now.getMonth()));
      }
      const contribMonths = Math.max(0, totalMonthsToRet - delayMonths);
      let val;
      if (cp.valueFromAge) {
        const fromDelayMonths = Math.max(0, (cp.valueFromAge - cp._ownerCurrentAge) * 12);
        if (fromDelayMonths >= totalMonthsToRet) {
          val = 0;
        } else {
          const growthMonths = totalMonthsToRet - fromDelayMonths;
          val = monthlyRate > 0 ? cp.value * Math.pow(1 + monthlyRate, growthMonths) : cp.value;
        }
      } else {
        val = monthlyRate > 0
          ? cp.value * Math.pow(1 + monthlyRate, totalMonthsToRet)
          : cp.value;
      }
      if ((cp.monthlyContrib || 0) > 0 && contribMonths > 0) {
        val += monthlyRate > 0
          ? cp.monthlyContrib * (Math.pow(1 + monthlyRate, contribMonths) - 1) / monthlyRate
          : cp.monthlyContrib * contribMonths;
      }
      return Math.max(0, val);
    }
  });

  // Sort draw order: cash/cash_isa first, then ss_isa, then lisa (LISA locked until age 60)
  const detCashDrawOrder = Array.from({ length: cashBals.length }, (_, ci) => {
    const t = allCashPots[ci].type || 'cash';
    return { ci, priority: t === 'lisa' ? 2 : t === 'ss_isa' ? 1 : 0 };
  }).sort((a, b) => a.priority - b.priority).map(x => x.ci);

  // Year-by-year cash accumulation for the chart (annual-step approximation, from today to retirement)
  const accCashByYear = new Float64Array(fullYearsToRet + 1);
  accCashByYear[0] = allCashPots.reduce((s, cp) => s + (cp.value || 0), 0);
  if (fullYearsToRet > 0) {
    const cashAccBals = allCashPots.map(cp => cp.value || 0);
    const now = new Date();
    for (let y = 0; y < fullYearsToRet; y++) {
      for (let ci2 = 0; ci2 < allCashPots.length; ci2++) {
        const cp = allCashPots[ci2];
        const cpType = cp.type || 'cash';
        const isML = cpType === 'ss_isa' || cpType === 'lisa';
        // Inject arriving lump sum
        if (cp.valueFromAge && cp.valueFromAge === Math.round(cp._ownerCurrentAge + y)) {
          cashAccBals[ci2] += cp.value || 0;
        }
        // Growth
        if (isML) {
          const _eq = (cp.equityPct || 80) / 100;
          cashAccBals[ci2] *= 1 + (_eq * meanEq + (1 - _eq) * meanBd) * scaleFactor / 100;
        } else {
          cashAccBals[ci2] *= 1 + (cp.interestPct || 0) / 100;
        }
        // Contributions
        let delayYears = 0;
        if (cp.contribStartMonth) {
          const [cy, cm] = cp.contribStartMonth.split('-').map(Number);
          delayYears = Math.max(0, (cy - now.getFullYear()) * 12 + (cm - 1 - now.getMonth())) / 12;
        }
        if (y >= delayYears && (cp.monthlyContrib || 0) > 0) {
          cashAccBals[ci2] += (cp.monthlyContrib || 0) * 12;
          if (cpType === 'lisa' && cp._ownerCurrentAge + y < 50) {
            cashAccBals[ci2] += Math.min((cp.monthlyContrib || 0) * 12, 4000) * 0.25;
          }
        }
      }
      accCashByYear[y + 1] = cashAccBals.reduce((s, v) => s + v, 0);
    }
  }

  // --- Retirement: year-by-year ---
  const detPotByYear = new Float64Array(years + 1);
  const detCashBalByYear = new Float64Array(years + 1);
  const detCashContribByYear = new Float64Array(years + 1);

  detPotByYear[0] = pensionPot;
  detCashBalByYear[0] = cashBals.reduce((s, v) => s + v, 0);

  const retCalYear = new Date().getFullYear() + Math.round(yearsToRetirement);
  let annuityPurchasedDet = false;
  for (let y = 0; y < years; y++) {
    const age = p.retirementAge + y;
    const ci = Math.pow(baseInflFactor, y);

    // Inject lump sums arriving this retirement year
    for (let ci2 = 0; ci2 < cashBals.length; ci2++) {
      if (allCashPots[ci2].valueFromAge && (allCashPots[ci2]._ownerCurrentAge + (age - p.currentAge)) === allCashPots[ci2].valueFromAge) {
        cashBals[ci2] += allCashPots[ci2].value;
      }
    }
    // Cash pot growth (market-linked for S&S ISA/LISA, fixed rate for cash/cash_isa)
    for (let ci2 = 0; ci2 < cashBals.length; ci2++) {
      const _cpType = allCashPots[ci2].type || 'cash';
      if (_cpType === 'ss_isa' || _cpType === 'lisa') {
        const _eq = (allCashPots[ci2].equityPct || 80) / 100;
        cashBals[ci2] *= 1 + (_eq * meanEq + (1 - _eq) * meanBd) * scaleFactor / 100;
      } else {
        cashBals[ci2] *= (1 + allCashPots[ci2].interestPct / 100);
      }
    }

    // One-time annuity purchase: deduct premium from pension pot at annuityAge
    if (p.annuityEnabled && !annuityPurchasedDet && age === (p.annuityAge ?? 9999)) {
      annuityPurchasedDet = true;
      detPotByYear[y] = Math.max(0, detPotByYear[y] - Math.min(p.annuityPremium || 0, detPotByYear[y]));
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
    const ageCtxDet = { currentAge: age, retirementAge: p.retirementAge, yearsToRetirement, baseInflFactor };
    const otherGrossDet = calcOtherIncomesNet(p.incomes || [], ciFromNowDet, ageCtxDet).grossTotal;
    const dbGrossDet = calcDbIncome(p.dbPensions, p.spAge, age, ciFromNowDet).grossTotal;
    const partnerOtherGrossDet = (p.partner?.incomes?.length && partnerRetiredDet)
      ? calcOtherIncomesNet(p.partner.incomes, ciFromNowDet, { currentAge: partnerAge, retirementAge: p.partner.retirementAge, yearsToRetirement: Math.max(0, p.partner.retirementAge - (p.partner.currentAgeFrac ?? p.partner.currentAge)), baseInflFactor }).grossTotal : 0;
    const partnerDbGrossDet = p.partner ? calcDbIncome(p.partner.dbPensions, p.partner.spAge, partnerAge, ciFromNowDet).grossTotal : 0;
    const totalOtherGrossDet = otherGrossDet + partnerOtherGrossDet + dbGrossDet + partnerDbGrossDet;
    const inflFactor = p.drawdownInflation ? ci : 1.0;
    const baseTargetDet = p.drawdown * inflFactor;
    const goalExtraDet = (p.spendingGoals || []).reduce((sum, g) =>
      (age >= (g.startAge || 0) && age <= (g.endAge || g.startAge || 0)) ? sum + (g.extraAnnual || 0) * inflFactor : sum, 0);
    const targetNominal = (age >= p.reductionAge
      ? Math.max(0, (baseTargetDet + totalOtherGrossDet) * (1 - p.reductionPct / 100) - totalOtherGrossDet)
      : baseTargetDet) + goalExtraDet;
    const annuityNomDet = (p.annuityEnabled && annuityPurchasedDet) ? (p.annuityIncome || 0) * ci : 0;
    const grossNeeded = Math.max(0, targetNominal - spNom - partnerSpNom - annuityNomDet);

    // Use notional tax to work out net target (same pattern as MC)
    const notionalTc = calcPensionTax(grossNeeded, spNom, hasSP, p.taxFreeFrac || 0.25);
    const netTarget = notionalTc.pensionNet;

    // Draw from cash pots in priority order: cash/cash_isa → ss_isa → lisa (age 60+ only)
    let cashRemaining = netTarget;
    for (const _ci2 of detCashDrawOrder) {
      if (cashRemaining <= 0) break;
      if ((allCashPots[_ci2].type || 'cash') === 'lisa' && age < 60) continue;
      const take = Math.min(cashBals[_ci2], cashRemaining);
      cashBals[_ci2] -= take;
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

  return { detPotByYear, detCashBalByYear, detCashContribByYear, accPensionByYear, accCashByYear, accYearsToRet: fullYearsToRet };
}

export function buildAnnualIncomeData(r, pctileIdx) {
  const p = r.p;
  const baseInflFactor = 1 + p.inflation / 100;
  const yearsToRetirement = Math.max(0, p.retirementAge - (p.currentAgeFrac ?? p.currentAge));
  const currentYear = new Date().getFullYear();
  const startPensionPot = r.startPensionPot || r.startPot;

  const cashBals = r.startCashPotVals ? Float64Array.from(r.startCashPotVals) : new Float64Array(0);
  // Build combined pot list and draw order for cash pots
  const _baidAllCashPots = [...(p.cashPots || []), ...(p.partner?.cashPots || [])];
  const _baidCashDrawOrder = Array.from({ length: cashBals.length }, (_, ci) => {
    const t = (_baidAllCashPots[ci]?.type) || 'cash';
    return { ci, priority: t === 'lisa' ? 2 : t === 'ss_isa' ? 1 : 0 };
  }).sort((a, b) => a.priority - b.priority).map(x => x.ci);
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
      if (p.cashPots[ci2].valueFromAge && p.cashPots[ci2].valueFromAge === age) {
        cashBals[ci2] += p.cashPots[ci2].value;
      }
    }
    // Compute taxable cash savings interest BEFORE growth is applied (plain cash pots only)
    let cashInterestNom = 0;
    for (let ci2 = 0; ci2 < (p.cashPots || []).length; ci2++) {
      const _cpType = p.cashPots[ci2].type || 'cash';
      if (_cpType !== 'ss_isa' && _cpType !== 'lisa') {
        cashInterestNom += cashBals[ci2] * (p.cashPots[ci2].interestPct || 0) / 100;
      }
    }
    for (let ci2 = 0; ci2 < (p.cashPots || []).length; ci2++) {
      const _cpType = p.cashPots[ci2].type || 'cash';
      cashBals[ci2] *= _cpType === 'ss_isa' || _cpType === 'lisa'
        ? 1 + (r.returnPct ?? 5) / 100
        : 1 + p.cashPots[ci2].interestPct / 100;
    }

    const ageCtxAID = { currentAge: age, retirementAge: p.retirementAge, yearsToRetirement, baseInflFactor };
    const otherNet = calcOtherIncomesNet(p.incomes, ciFromNow, ageCtxAID);
    const partnerRetiredAID = !!(p.partner && partnerAge >= p.partner.retirementAge);
    const partnerOtherAID = (p.partner?.incomes?.length && partnerRetiredAID)
      ? calcOtherIncomesNet(p.partner.incomes, ciFromNow, { currentAge: partnerAge, retirementAge: p.partner.retirementAge, yearsToRetirement: Math.max(0, p.partner.retirementAge - (p.partner.currentAgeFrac ?? p.partner.currentAge)), baseInflFactor }) : { grossTotal: 0, taxTotal: 0, netTotal: 0 };
    // Add DB pension income to other net totals (employment type, inflated from today)
    const dbIncAID = calcDbIncome(p.dbPensions, p.spAge, age, ciFromNow);
    const dbGrossAID = dbIncAID.grossTotal;
    otherNet.grossTotal += dbGrossAID;
    otherNet.byType.employment = (otherNet.byType.employment || 0) + dbIncAID.byType.employment;
    const partnerDbIncAID = p.partner ? calcDbIncome(p.partner.dbPensions, p.partner.spAge, partnerAge, ciFromNow) : { grossTotal: 0 };
    partnerOtherAID.grossTotal = (partnerOtherAID.grossTotal || 0) + partnerDbIncAID.grossTotal;
    partnerOtherAID.netTotal = (partnerOtherAID.netTotal || 0) + partnerDbIncAID.grossTotal;
    // Reduction applies to total gross income (drawdown target + other incomes combined).
    // Only the drawdown target can be cut; other incomes are fixed. Floor at 0.
    const inflFactor = p.drawdownInflation ? ci : 1.0;
    const baseTarget = p.drawdown * inflFactor;
    const goalExtraAID = (p.spendingGoals || []).reduce((sum, g) =>
      (age >= (g.startAge || 0) && age <= (g.endAge || g.startAge || 0)) ? sum + (g.extraAnnual || 0) * inflFactor : sum, 0);
    const totalOtherGross = otherNet.grossTotal + partnerOtherAID.grossTotal;
    const targetNominal = (age >= p.reductionAge
      ? Math.max(0, (baseTarget + totalOtherGross) * (1 - p.reductionPct / 100) - totalOtherGross)
      : baseTarget) + goalExtraAID;
    const annuityNomAID = (p.annuityEnabled && age >= (p.annuityAge ?? 9999)) ? (p.annuityIncome || 0) * ci : 0;
    const neededFromPots = Math.max(0, targetNominal - spInflated - partnerSpInflated - annuityNomAID);

    // Add taxable cash savings interest to savings income tier for correct tax stacking.
    // Done after targetNominal to avoid cash interest affecting drawdown target.
    otherNet.byType.savings = (otherNet.byType.savings || 0) + cashInterestNom;
    otherNet.grossTotal += cashInterestNom;

    const notionalTcAnn = calcPensionTax(neededFromPots, spInflated, hasStatePension, r.taxFreeFrac, otherNet.byType, currentYear + (age - p.currentAge));
    const netTargetAnn = notionalTcAnn.pensionNet;
    // alwaysTaxFree: draw enough pension to use remaining Personal Allowance.
    // Under UFPLS (25% tax-free): drawing PA / 0.75 = £16,760 means 25% is tax-free and
    // 75% is taxable but fully covered by the PA — zero income tax on the whole draw.
    const _atfTfFracEst = (p.taxFreeMode !== 'none' && p.taxFreeMode !== 'pcls' && cumulPrimaryTaxFree < LSA) ? 0.25 : 0;
    const _atfRemainingPA = _atfTfFracEst > 0 ? Math.max(0, PA - spInflated - (otherNet.byType.employment || 0)) : 0;
    const _atfMinPensionGross = (_atfRemainingPA > 0 && neededFromPots > 0)
      ? Math.min(pensionAtPctile, neededFromPots, _atfRemainingPA / (1 - _atfTfFracEst))
      : 0;
    const _atfCashTarget = (
      p.alwaysTaxFree && !guardrailActive && !potDepleted && _atfMinPensionGross > 0 && netTargetAnn > 0
    ) ? Math.max(0, netTargetAnn - _atfMinPensionGross * (netTargetAnn / neededFromPots))
      : netTargetAnn;
    let cashContrib = 0;
    for (const _ci2 of _baidCashDrawOrder) {
      if (cashContrib >= _atfCashTarget) break;
      if ((_baidAllCashPots[_ci2]?.type || 'cash') === 'lisa' && age < 60) continue;
      const take = Math.min(cashBals[_ci2], _atfCashTarget - cashContrib);
      cashBals[_ci2] -= take;
      cashContrib += take;
    }

    const remainingNetAnn = Math.max(0, netTargetAnn - cashContrib);
    const intendedPensionWithdrawal = netTargetAnn > 0
      ? remainingNetAnn * (neededFromPots / netTargetAnn) * guardrailFactor
      : 0;
    const potWithdrawNominal = potDepleted ? 0 : Math.min(pensionAtPctile, intendedPensionWithdrawal);

    // Per-year tax-free fracs — respects taxFreeMode (ufpls / pcls / none) per person
    // PCLS: pot already reduced at retirement, all subsequent drawdown is fully taxable
    const actualPriDraw = potWithdrawNominal * primaryPotFrac_;
    const actualParDraw = potWithdrawNominal * (1 - primaryPotFrac_);
    const priMode = p.taxFreeMode || 'ufpls';
    const parMode = p.partner?.taxFreeMode || 'ufpls';
    let primaryTFracYear;
    if (priMode === 'none' || priMode === 'pcls') {
      primaryTFracYear = 0;
    } else {
      // UFPLS: 25% each year until LSA exhausted
      primaryTFracYear = actualPriDraw > 0
        ? Math.min(0.25, Math.max(0, LSA - cumulPrimaryTaxFree) / actualPriDraw)
        : (cumulPrimaryTaxFree < LSA ? 0.25 : 0);
    }
    let partnerTFracYear;
    if (parMode === 'none' || parMode === 'pcls') {
      partnerTFracYear = 0;
    } else {
      partnerTFracYear = (p.partner && actualParDraw > 0)
        ? Math.min(0.25, Math.max(0, LSA - cumulPartnerTaxFree) / actualParDraw)
        : 0.25;
    }
    const taxFreeFracYear = potWithdrawNominal > 0
      ? (actualPriDraw * primaryTFracYear + actualParDraw * partnerTFracYear) / potWithdrawNominal
      : 0.25;
    const tc = calcPensionTax(potWithdrawNominal, spInflated, hasStatePension, taxFreeFracYear, otherNet.byType, currentYear + (age - p.currentAge));
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
    // Split DB from non-DB other income for separate display column
    const _dbTaxAID = otherNet.grossTotal > 0 ? tc.otherTax * (dbGrossAID / otherNet.grossTotal) : 0;
    const _dbNetAID = dbGrossAID - _dbTaxAID;
    const _nonDbOtherGrossAID = otherNet.grossTotal - dbGrossAID;
    const _nonDbOtherTaxAID = tc.otherTax - _dbTaxAID;
    const _nonDbOtherNetAID = tc.otherNet - _dbNetAID;

    result.push({
      age,
      calYear: currentYear + (age - p.currentAge),
      cashNom: cashContrib / 12,
      cashReal: (cashContrib * todayDeflator) / 12,
      pensionNom: tc.pensionNet / 12,
      // SP: show gross as headline so both SP columns are directly comparable
      spNom: spInflated / 12,
      spReal: (spInflated * todayDeflator) / 12,
      otherNom: _nonDbOtherNetAID / 12,
      dbNom: _dbNetAID / 12,
      netNom: totalNetNominal / 12,
      pensionReal: (tc.pensionNet * todayDeflator) / 12,
      otherReal: (_nonDbOtherNetAID * todayDeflator) / 12,
      dbReal: (_dbNetAID * todayDeflator) / 12,
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
      partnerOtherNom: partnerOtherAID.netTotal / 12,
      partnerOtherReal: (partnerOtherAID.netTotal * todayDeflator) / 12,
      partnerOtherGrossNom: partnerOtherAID.grossTotal / 12,
      partnerOtherGrossReal: (partnerOtherAID.grossTotal * todayDeflator) / 12,
      partnerOtherTaxNom: (partnerOtherAID.taxTotal || 0) / 12,
      partnerOtherTaxReal: ((partnerOtherAID.taxTotal || 0) * todayDeflator) / 12,
      otherGrossNom: _nonDbOtherGrossAID / 12,
      otherTaxNom: _nonDbOtherTaxAID / 12,
      otherGrossReal: (_nonDbOtherGrossAID * todayDeflator) / 12,
      otherTaxReal: (_nonDbOtherTaxAID * todayDeflator) / 12,
      dbGrossNom: dbGrossAID / 12,
      dbTaxNom: _dbTaxAID / 12,
      dbGrossReal: (dbGrossAID * todayDeflator) / 12,
      dbTaxReal: (_dbTaxAID * todayDeflator) / 12,
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
      cashInterestAnn: cashInterestNom,
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
  const allCashPots = [
    ...(p.cashPots || []).map(cp => ({ ...cp, _ownerCurrentAge: p.currentAge })),
    ...(p.partner?.cashPots || []).map(cp => ({ ...cp, _ownerCurrentAge: p.partner.currentAge })),
  ];
  const numCashPots = allCashPots.length;
  const startCashPotVals = new Float64Array(numCashPots);
  allCashPots.forEach((cp, ci) => {
    const cpType = cp.type || 'cash';
    const isML = cpType === 'ss_isa' || cpType === 'lisa';
    if (isML) {
      // S&S ISA / LISA: annual compounding at user's expected return
      const annualRate = (p.returnPct ?? 5) / 100;
      const ownerAge = cp._ownerCurrentAge;
      const now = new Date();
      let delayYears = 0;
      if (cp.contribStartMonth) {
        const [cy, cm] = cp.contribStartMonth.split('-').map(Number);
        delayYears = Math.max(0, (cy - now.getFullYear()) * 12 + (cm - 1 - now.getMonth())) / 12;
      }
      const contribYears = Math.max(0, yearsToRetirement - delayYears);
      const annualContrib = (cp.monthlyContrib || 0) * 12;
      let val;
      if (cp.valueFromAge) {
        const yearsUntilArrives = Math.max(0, cp.valueFromAge - ownerAge);
        if (yearsUntilArrives >= yearsToRetirement) {
          val = 0;
        } else {
          const growthYears = yearsToRetirement - yearsUntilArrives;
          val = annualRate > 0 ? cp.value * Math.pow(1 + annualRate, growthYears) : cp.value;
        }
      } else {
        val = annualRate > 0 ? cp.value * Math.pow(1 + annualRate, yearsToRetirement) : cp.value;
      }
      if (annualContrib > 0 && contribYears > 0) {
        val += annualRate > 0
          ? annualContrib * (Math.pow(1 + annualRate, contribYears) - 1) / annualRate
          : annualContrib * contribYears;
      }
      // LISA: 25% govt bonus on up to £4,000/yr contributions while owner age < 50
      if (cpType === 'lisa' && annualContrib > 0 && ownerAge < 50) {
        const lisaBonus = Math.min(annualContrib, 4000) * 0.25;
        const eligibleYears = Math.max(0, Math.min(contribYears, 50 - ownerAge));
        if (eligibleYears > 0) {
          val += annualRate > 0
            ? lisaBonus * (Math.pow(1 + annualRate, eligibleYears) - 1) / annualRate
            : lisaBonus * eligibleYears;
        }
      }
      startCashPotVals[ci] = Math.max(0, val);
    } else {
      // Fixed interest: monthly compounding (existing logic)
      const totalMonthsToRet = Math.round(yearsToRetirement * 12);
      const monthlyRate = cp.interestPct / 100 / 12;
      const now = new Date();
      let delayMonths = 0;
      if (cp.contribStartMonth) {
        const [cy, cm] = cp.contribStartMonth.split('-').map(Number);
        delayMonths = Math.max(0, (cy - now.getFullYear()) * 12 + (cm - 1 - now.getMonth()));
      }
      const contribMonths = Math.max(0, totalMonthsToRet - delayMonths);
      let val;
      if (cp.valueFromAge) {
        const fromDelayMonths = Math.max(0, (cp.valueFromAge - cp._ownerCurrentAge) * 12);
        if (fromDelayMonths >= totalMonthsToRet) {
          val = 0;
        } else {
          const growthMonths = totalMonthsToRet - fromDelayMonths;
          val = monthlyRate > 0 ? cp.value * Math.pow(1 + monthlyRate, growthMonths) : cp.value;
        }
      } else {
        val = monthlyRate > 0
          ? cp.value * Math.pow(1 + monthlyRate, totalMonthsToRet)
          : cp.value;
      }
      if ((cp.monthlyContrib || 0) > 0 && contribMonths > 0) {
        val += monthlyRate > 0
          ? cp.monthlyContrib * (Math.pow(1 + monthlyRate, contribMonths) - 1) / monthlyRate
          : cp.monthlyContrib * contribMonths;
      }
      startCashPotVals[ci] = Math.max(0, val);
    }
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

  // Each person's pot gets its own LSA (£268,275)
  // For PCLS: income from the reduced pot is fully taxable (taxFreeFrac = 0)
  // For UFPLS: 25% of each withdrawal is tax-free until LSA is used up
  const primaryPotMedian = Float64Array.from(primaryStartTotals).sort()[Math.floor(nRuns / 2)];
  const partnerPotMedian = Float64Array.from(partnerStartTotals).sort()[Math.floor(nRuns / 2)];
  const priMode_ = p.taxFreeMode || 'ufpls';
  const parMode_ = p.partner?.taxFreeMode || 'ufpls';
  // PCLS amounts (from median pots) — deducted from the pot at retirement
  const primaryPclsAmt = priMode_ === 'pcls'
    ? Math.min((p.pclsPct || 0) / 100 * primaryPotMedian, LSA, primaryPotMedian * 0.25) : 0;
  const partnerPclsAmt = (p.partner && parMode_ === 'pcls')
    ? Math.min((p.partner?.pclsPct || 0) / 100 * partnerPotMedian, LSA, partnerPotMedian * 0.25) : 0;
  // startPensionPot post-PCLS (used for drawdown% mode and card display)
  const startPensionPotPrePcls = startPensionPot;
  const startPensionPotPostPcls = Math.max(0, startPensionPot - primaryPclsAmt - partnerPclsAmt);

  // taxFreeFrac scalar: 0 for PCLS (pot reduced, income fully taxable); 0 for none; 25%-until-LSA for UFPLS
  const primaryTaxFreeAmt = priMode_ === 'none' || priMode_ === 'pcls' ? 0
    : (primaryPotMedian > 0 ? primaryPotMedian * Math.min(0.25, LSA / primaryPotMedian) : 0);
  const partnerTaxFreeAmt = !p.partner || parMode_ === 'none' || parMode_ === 'pcls' ? 0
    : (partnerPotMedian > 0 ? partnerPotMedian * Math.min(0.25, LSA / partnerPotMedian) : 0);
  const taxFreeFrac = startPensionPotPostPcls > 0 ? (primaryTaxFreeAmt + partnerTaxFreeAmt) / startPensionPotPostPcls : (priMode_ === 'ufpls' ? 0.25 : 0);
  // Per-person fractions for tax breakdown display
  const primaryTaxFreeFrac = priMode_ === 'none' || priMode_ === 'pcls' ? 0
    : (primaryPotMedian > 0 ? Math.min(0.25, LSA / primaryPotMedian) : 0.25);
  const partnerTaxFreeFrac = !p.partner || parMode_ === 'none' || parMode_ === 'pcls' ? 0
    : (partnerPotMedian > 0 ? Math.min(0.25, LSA / partnerPotMedian) : 0.25);
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

  const retCalYear = new Date().getFullYear() + Math.round(yearsToRetirement);

  // Sort cash pot draw order: cash/cash_isa first, then ss_isa, then lisa (LISA locked until age 60)
  const cashDrawOrder = Array.from({ length: numCashPots }, (_, ci) => {
    const t = allCashPots[ci].type || 'cash';
    return { ci, priority: t === 'lisa' ? 2 : t === 'ss_isa' ? 1 : 0 };
  }).sort((a, b) => a.priority - b.priority).map(x => x.ci);

  for (let r = 0; r < nRuns; r++) {
    const runPots = new Float64Array(numPots);
    potsOrder.forEach((origIdx, rank) => { runPots[rank] = startPotsPerRun[r][origIdx]; });

    // PCLS: deduct per-run lump sum from pension pots at retirement
    const _runPensionTotal = runPots.reduce((s, v) => s + v, 0);
    const _runPriPcls = priMode_ === 'pcls' ? Math.min((p.pclsPct||0)/100 * primaryStartTotals[r], LSA, primaryStartTotals[r] * 0.25) : 0;
    const _runParPcls = parMode_ === 'pcls' ? Math.min((p.partner?.pclsPct||0)/100 * partnerStartTotals[r], LSA, partnerStartTotals[r] * 0.25) : 0;
    const _runPclsTotal = _runPriPcls + _runParPcls;
    if (_runPclsTotal > 0 && _runPensionTotal > 0) {
      const _scale = Math.max(0, (_runPensionTotal - _runPclsTotal) / _runPensionTotal);
      for (let pi = 0; pi < numPots; pi++) runPots[pi] *= _scale;
    }

    const runCashPots = Float64Array.from(startCashPotVals);
    const runStartValues = Float64Array.from(runPots);
    let cumulInfl = 1.0;
    potMatrix[r][0] = runCashPots.reduce((s, v) => s + v, 0) + runPots.reduce((s, v) => s + v, 0);
    let guardrailEverTriggered = false;
    let annuityPurchased = false;

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

      // Inject lump sums arriving this retirement year
      for (let ci = 0; ci < numCashPots; ci++) {
        if (allCashPots[ci].valueFromAge && (allCashPots[ci]._ownerCurrentAge + (age - p.currentAge)) === allCashPots[ci].valueFromAge) {
          runCashPots[ci] += allCashPots[ci].value;
        }
      }
      // One-time annuity purchase: deduct premium from pension pots proportionally at annuityAge
      if (p.annuityEnabled && !annuityPurchased && age === (p.annuityAge ?? 9999)) {
        annuityPurchased = true;
        const _aPremium = p.annuityPremium || 0;
        const _aPotTotal = runPots.reduce((s, v) => s + v, 0);
        if (_aPremium > 0 && _aPotTotal > 0) {
          const _aDeduct = Math.min(_aPremium, _aPotTotal);
          for (let pi = 0; pi < numPots; pi++) {
            runPots[pi] = Math.max(0, runPots[pi] - _aDeduct * (runPots[pi] / _aPotTotal));
          }
        }
      }
      // cash growth (market-linked for S&S ISA/LISA, fixed rate for cash/cash_isa)
      const yearIdx = Math.floor(Math.random() * HIST_EQUITY_RETURNS.length);
      const eqRetYear = HIST_EQUITY_RETURNS[yearIdx];
      const bdRetYear = HIST_BONDS_RETURNS[yearIdx];
      for (let ci = 0; ci < numCashPots; ci++) {
        const _cpType = allCashPots[ci].type || 'cash';
        if (_cpType === 'ss_isa' || _cpType === 'lisa') {
          const _eq = (allCashPots[ci].equityPct || 80) / 100;
          runCashPots[ci] *= 1 + (_eq * eqRetYear + (1 - _eq) * bdRetYear) / 100;
        } else {
          runCashPots[ci] *= (1 + allCashPots[ci].interestPct / 100);
        }
      }

      let blendedRet = 0;
      const totalForBlend = runPots.reduce((s, v) => s + v, 0);
      for (let rank = 0; rank < numPots; rank++) {
        const origIdx = potsOrder[rank];
        const eq = effectiveEquityPct(allPotsConfig[origIdx], age, p.retirementAge) / 100;
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

      const pensionOnlyStart = Math.max(0, startTotals[r] - _runPclsTotal);
      const guardrailActive = p.guardrails && pensionTotalAfterGrowth < pensionOnlyStart * 0.80;
      if (guardrailActive) guardrailEverTriggered = true;

      const hasSPthisYear = age >= p.spAge;
      const spNomMC = hasSPthisYear ? p.sp * cumulInfl : 0;
      const partnerAgeMC = p.partner ? p.partner.currentAge + (age - p.currentAge) : null;
      const partnerSpNomMC = (p.partner && partnerAgeMC >= p.partner.spAge) ? p.partner.sp * cumulInfl : 0;
      // Use base inflation for pre-retirement portion; stochastic cumulInfl from retirement onward
      const ciMCFromNow = Math.pow(1 + p.inflation / 100, yearsToRetirement) * cumulInfl;
      const partnerRetiredMC = !!(p.partner && partnerAgeMC >= p.partner.retirementAge);
      const baseInflMC = 1 + p.inflation / 100;
      const ageCtxMC = { currentAge: age, retirementAge: p.retirementAge, yearsToRetirement, baseInflFactor: baseInflMC };
      const otherGrossMC = calcOtherIncomesNet(p.incomes || [], ciMCFromNow, ageCtxMC).grossTotal;
      const dbGrossMC = calcDbIncome(p.dbPensions, p.spAge, age, ciMCFromNow).grossTotal;
      const partnerOtherGrossMC = (p.partner?.incomes?.length && partnerRetiredMC)
        ? calcOtherIncomesNet(p.partner.incomes, ciMCFromNow, { currentAge: partnerAgeMC, retirementAge: p.partner.retirementAge, yearsToRetirement: Math.max(0, p.partner.retirementAge - (p.partner.currentAgeFrac ?? p.partner.currentAge)), baseInflFactor: baseInflMC }).grossTotal : 0;
      const partnerDbGrossMC = p.partner ? calcDbIncome(p.partner.dbPensions, p.partner.spAge, partnerAgeMC, ciMCFromNow).grossTotal : 0;
      const totalOtherGrossMC = otherGrossMC + partnerOtherGrossMC + dbGrossMC + partnerDbGrossMC;
      const inflFactor = p.drawdownInflation ? cumulInfl : 1.0;
      const baseTargetMC = p.drawdown * inflFactor;
      const goalExtraMC = (p.spendingGoals || []).reduce((sum, g) =>
        (age >= (g.startAge || 0) && age <= (g.endAge || g.startAge || 0)) ? sum + (g.extraAnnual || 0) * inflFactor : sum, 0);
      const targetNominal = (age >= p.reductionAge
        ? Math.max(0, (baseTargetMC + totalOtherGrossMC) * (1 - p.reductionPct / 100) - totalOtherGrossMC)
        : baseTargetMC) + goalExtraMC;
      const annuityNomMC = (p.annuityEnabled && annuityPurchased) ? (p.annuityIncome || 0) * cumulInfl : 0;
      const grossWithdrawal = Math.max(0, targetNominal - spNomMC - partnerSpNomMC - annuityNomMC);

      const notionalTc = calcPensionTax(grossWithdrawal, spNomMC, hasSPthisYear, taxFreeFrac);
      const netTarget = notionalTc.pensionNet;
      // alwaysTaxFree: draw enough pension to use remaining Personal Allowance (MC loop).
      // SP + DB income consume PA first; remaining PA / 0.75 = minimum pension draw (UFPLS 25%).
      const _atfTfFracMC = (p.taxFreeMode !== 'none' && p.taxFreeMode !== 'pcls') ? 0.25 : 0;
      const _atfRemainingPAmc = _atfTfFracMC > 0 ? Math.max(0, PA - spNomMC - dbGrossMC) : 0;
      const _atfMinPensionMC = (_atfRemainingPAmc > 0 && grossWithdrawal > 0)
        ? Math.min(pensionTotalAfterGrowth, grossWithdrawal, _atfRemainingPAmc / (1 - _atfTfFracMC))
        : 0;
      const _atfCashBudgetMC = (
        p.alwaysTaxFree && !guardrailActive && _atfMinPensionMC > 0 && netTarget > 0
      ) ? Math.max(0, netTarget - _atfMinPensionMC * (netTarget / grossWithdrawal))
        : netTarget;
      // Draw from cash pots in priority order: cash/cash_isa → ss_isa → lisa (age 60+ only)
      let cashRemaining = _atfCashBudgetMC;
      for (const _ci of cashDrawOrder) {
        if (cashRemaining <= 0) break;
        if ((allCashPots[_ci].type || 'cash') === 'lisa' && age < 60) continue;
        const take = Math.min(runCashPots[_ci], cashRemaining);
        runCashPots[_ci] -= take;
        cashRemaining -= take;
      }
      const cashTaken = _atfCashBudgetMC - cashRemaining;

      const guardrailFactor = guardrailActive ? 0.90 : 1.0;
      const remainingNet = Math.max(0, netTarget - cashTaken);
      const _pensionWithdrawalTarget = netTarget > 0
        ? remainingNet * (grossWithdrawal / netTarget) * guardrailFactor
        : 0;
      let pensionWithdrawal = _pensionWithdrawalTarget;
      for (let rank = 0; rank < numPots && pensionWithdrawal > 0; rank++) {
        const take = Math.min(runPots[rank], pensionWithdrawal);
        runPots[rank] -= take;
        pensionWithdrawal -= take;
      }
      // LISA early draw (age < 60): only if pension pots also depleted — 25% penalty applies
      if (age < 60 && pensionWithdrawal > 0) {
        const pensionActual = _pensionWithdrawalTarget - pensionWithdrawal;
        const netFromPension = grossWithdrawal > 0 ? pensionActual * (netTarget / grossWithdrawal) : 0;
        let _lisaDeficit = Math.max(0, remainingNet - netFromPension);
        for (const _ci of cashDrawOrder) {
          if ((allCashPots[_ci].type || 'cash') !== 'lisa' || runCashPots[_ci] <= 0 || _lisaDeficit <= 0) continue;
          const take = Math.min(runCashPots[_ci], _lisaDeficit / 0.75);
          runCashPots[_ci] -= take;
          _lisaDeficit -= take * 0.75;
        }
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
      for (let ci = 0; ci < numCashPots; ci++) {
        const _cpType = allCashPots[ci].type || 'cash';
        cb[ci] *= _cpType === 'ss_isa' || _cpType === 'lisa'
          ? 1 + (p.returnPct ?? 5) / 100
          : 1 + allCashPots[ci].interestPct / 100;
      }
      const inflFactor = p.drawdownInflation ? Math.pow(inflF, y) : 1.0;
      const hasSP = age >= p.spAge;
      const spNomDet = hasSP ? p.sp * Math.pow(inflF, y) : 0;
      const partnerAgeDet = p.partner ? p.partner.currentAge + (age - p.currentAge) : null;
      const partnerSpNomDet = (p.partner && partnerAgeDet >= p.partner.spAge) ? p.partner.sp * Math.pow(inflF, y) : 0;
      const ciCashFromNow = Math.pow(inflF, yearsToRetirement + y);
      const partnerRetiredCash = !!(p.partner && partnerAgeDet >= p.partner.retirementAge);
      const ageCtxCash = { currentAge: age, retirementAge: p.retirementAge, yearsToRetirement, baseInflFactor: inflF };
      const otherGrossCash = calcOtherIncomesNet(p.incomes || [], ciCashFromNow, ageCtxCash).grossTotal;
      const dbGrossCash = calcDbIncome(p.dbPensions, p.spAge, age, ciCashFromNow).grossTotal;
      const partnerOtherGrossCash = (p.partner?.incomes?.length && partnerRetiredCash)
        ? calcOtherIncomesNet(p.partner.incomes, ciCashFromNow, { currentAge: partnerAgeDet, retirementAge: p.partner.retirementAge, yearsToRetirement: Math.max(0, p.partner.retirementAge - (p.partner.currentAgeFrac ?? p.partner.currentAge)), baseInflFactor: inflF }).grossTotal : 0;
      const partnerDbGrossCash = p.partner ? calcDbIncome(p.partner.dbPensions, p.partner.spAge, partnerAgeDet, ciCashFromNow).grossTotal : 0;
      const baseTargetCash = p.drawdown * inflFactor;
      const goalExtraCash = (p.spendingGoals || []).reduce((sum, g) =>
        (age >= (g.startAge || 0) && age <= (g.endAge || g.startAge || 0)) ? sum + (g.extraAnnual || 0) * inflFactor : sum, 0);
      const totalOtherGrossCash = otherGrossCash + partnerOtherGrossCash + dbGrossCash + partnerDbGrossCash;
      const adjustedTargetCash = (age >= p.reductionAge
        ? Math.max(0, (baseTargetCash + totalOtherGrossCash) * (1 - p.reductionPct / 100) - totalOtherGrossCash)
        : baseTargetCash) + goalExtraCash;
      const grossNeeded = Math.max(0, adjustedTargetCash - spNomDet - partnerSpNomDet);
      const ntc = calcPensionTax(grossNeeded, spNomDet, hasSP, taxFreeFrac);
      const netTarget = ntc.pensionNet;
      let remaining = netTarget;
      for (const _ci of cashDrawOrder) {
        if (remaining <= 0) break;
        if ((allCashPots[_ci].type || 'cash') === 'lisa' && age < 60) continue;
        const take = Math.min(cb[_ci], remaining); cb[_ci] -= take; remaining -= take;
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
  const partnerAgeAtRet = p.partner ? (p.partner.currentAgeFrac ?? p.partner.currentAge) + (p.retirementAge - (p.currentAgeFrac ?? p.currentAge)) : null;
  const partnerSpAtRet = (p.partner && partnerAgeAtRet >= p.partner.spAge) ? p.partner.sp : 0;
  const partnerRetiredAtRet = !!(p.partner && partnerAgeAtRet >= p.partner.retirementAge);
  const cashAtRetirement = cashContribByYear[0] || 0;
  const grossNeededRet = potWithdrawal(p.retirementAge, p, 1.0);
  const potWAtRetirement = pensionGrossAfterCash(grossNeededRet, cashAtRetirement, hasSpAtRetirement);
  const otherAtRetirement = calcOtherIncomesNet(p.incomes, Math.pow(baseInflFactor, yearsToRetirement), { currentAge: p.retirementAge, retirementAge: p.retirementAge, yearsToRetirement, baseInflFactor });
  const dbAtRet = calcDbIncome(p.dbPensions, p.spAge, p.retirementAge, Math.pow(baseInflFactor, yearsToRetirement));
  otherAtRetirement.grossTotal += dbAtRet.grossTotal;
  otherAtRetirement.byType.employment = (otherAtRetirement.byType.employment || 0) + dbAtRet.byType.employment;
  const partnerOtherAtRet = (partnerRetiredAtRet && p.partner.incomes?.length)
    ? calcOtherIncomesNet(p.partner.incomes, Math.pow(baseInflFactor, yearsToRetirement), { currentAge: partnerAgeAtRet, retirementAge: p.partner.retirementAge, yearsToRetirement: Math.max(0, p.partner.retirementAge - (p.partner.currentAgeFrac ?? p.partner.currentAge)), baseInflFactor })
    : { netTotal: 0, grossTotal: 0 };
  if (p.partner && partnerAgeAtRet !== null) {
    const partnerDbAtRet = calcDbIncome(p.partner.dbPensions, p.partner.spAge, partnerAgeAtRet, Math.pow(baseInflFactor, yearsToRetirement));
    partnerOtherAtRet.grossTotal = (partnerOtherAtRet.grossTotal || 0) + partnerDbAtRet.grossTotal;
    partnerOtherAtRet.netTotal = (partnerOtherAtRet.netTotal || 0) + partnerDbAtRet.grossTotal;
  }
  taxCalc = calcPensionTax(potWAtRetirement, hasSpAtRetirement ? p.sp : 0, hasSpAtRetirement, taxFreeFrac, otherAtRetirement.byType, new Date().getFullYear() + Math.round(yearsToRetirement));
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
    const otherNet = calcOtherIncomesNet(p.incomes, ciFromNow, { currentAge: age, retirementAge: p.retirementAge, yearsToRetirement, baseInflFactor });
    const dbIncRI = calcDbIncome(p.dbPensions, p.spAge, age, ciFromNow);
    otherNet.grossTotal += dbIncRI.grossTotal;
    otherNet.byType.employment = (otherNet.byType.employment || 0) + dbIncRI.byType.employment;
    const cashC = det.detCashContribByYear[yi] || 0;
    // Use deterministic projection to check whether the pension pot is depleted at this year
    const pensionDepleted = det.detPotByYear[yi] <= 0;
    const grossNeeded = potWithdrawal(age, p, ci);
    const potW = pensionDepleted ? 0 : pensionGrossAfterCash(grossNeeded, cashC, hasStatePension, spInfl);
    const tc = calcPensionTax(potW, spInfl, hasStatePension, taxFreeFrac, otherNet.byType, new Date().getFullYear() + (age - p.currentAge));
    const realF = Math.pow(1 / baseInflFactor, yi);
    const partnerAgeRI = p.partner ? p.partner.currentAge + (age - p.currentAge) : null;
    const partnerSpInflRI = (p.partner && partnerAgeRI >= p.partner.spAge) ? p.partner.sp * ci : 0;
    const partnerOtherRI = (p.partner?.incomes?.length && partnerAgeRI >= p.partner.retirementAge)
      ? calcOtherIncomesNet(p.partner.incomes, ciFromNow, { currentAge: partnerAgeRI, retirementAge: p.partner.retirementAge, yearsToRetirement: Math.max(0, p.partner.retirementAge - (p.partner.currentAgeFrac ?? p.partner.currentAge)), baseInflFactor }) : { grossTotal: 0, netTotal: 0 };
    if (p.partner && partnerAgeRI !== null) {
      const partnerDbRI = calcDbIncome(p.partner.dbPensions, p.partner.spAge, partnerAgeRI, ciFromNow);
      partnerOtherRI.grossTotal = (partnerOtherRI.grossTotal || 0) + partnerDbRI.grossTotal;
      partnerOtherRI.netTotal = (partnerOtherRI.netTotal || 0) + partnerDbRI.grossTotal;
    }
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
    const otherNet = calcOtherIncomesNet(p.incomes, ciFromNow, { currentAge: age, retirementAge: p.retirementAge, yearsToRetirement, baseInflFactor });
    const dbIncNM = calcDbIncome(p.dbPensions, p.spAge, age, ciFromNow);
    const dbGrossNM = dbIncNM.grossTotal;
    otherNet.grossTotal += dbGrossNM;
    otherNet.byType.employment = (otherNet.byType.employment || 0) + dbIncNM.byType.employment;
    const cashC = det.detCashContribByYear[yi] || 0;
    // Use deterministic projection to check whether the pension pot is depleted at this year
    const pensionDepleted = det.detPotByYear[yi] <= 0;
    const grossNeeded = potWithdrawal(age, p, ci);
    const potW = pensionDepleted ? 0 : pensionGrossAfterCash(grossNeeded, cashC, hasStatePension, spInfl);
    const tc = calcPensionTax(potW, spInfl, hasStatePension, taxFreeFrac, otherNet.byType, new Date().getFullYear() + (age - p.currentAge));
    const realF = Math.pow(1 / baseInflFactor, yi);
    const partnerAgeNM = p.partner ? p.partner.currentAge + (age - p.currentAge) : null;
    const partnerSpInflNM = (p.partner && partnerAgeNM >= p.partner.spAge) ? p.partner.sp * ci : 0;
    const partnerOtherNM = (p.partner?.incomes?.length && partnerAgeNM >= p.partner.retirementAge)
      ? calcOtherIncomesNet(p.partner.incomes, ciFromNow, { currentAge: partnerAgeNM, retirementAge: p.partner.retirementAge, yearsToRetirement: Math.max(0, p.partner.retirementAge - (p.partner.currentAgeFrac ?? p.partner.currentAge)), baseInflFactor }) : { netTotal: 0 };
    if (p.partner && partnerAgeNM !== null) {
      const partnerDbNM = calcDbIncome(p.partner.dbPensions, p.partner.spAge, partnerAgeNM, ciFromNow);
      partnerOtherNM.netTotal = (partnerOtherNM.netTotal || 0) + partnerDbNM.grossTotal;
    }
    const _dbTaxNM = otherNet.grossTotal > 0 ? tc.otherTax * (dbGrossNM / otherNet.grossTotal) : 0;
    const _dbNetNM = dbGrossNM - _dbTaxNM;
    return {
      age,
      cash: (cashC * realF) / 12,
      pension: (tc.pensionNet * realF) / 12,
      sp: hasStatePension ? (tc.spNet * realF) / 12 : 0,
      partnerSp: (partnerSpInflNM * realF) / 12,
      partnerOther: (partnerOtherNM.netTotal * realF) / 12,
      db: (_dbNetNM * realF) / 12,
      other: ((tc.otherNet - _dbNetNM) * realF) / 12
    };
  });

  const startInitialPotValues = allPotsConfig.reduce((s, pot) => s + (pot.value || 0), 0);

  const result = {
    ages, years, p, prob, guardrailPct, medianReal,
    swrPct, swr, netMonthly, grossMonthly, netAnnual, grossAnnual, startPot, startPensionPot, startCashTotal,
    startCashPotVals, cashContribByYear, cashBalByYear, taxFreeFrac, primaryTaxFreeFrac, partnerTaxFreeFrac, primaryPotFrac, startInitialPotValues,
    primaryPclsAmt, partnerPclsAmt,
    primaryPotPrePcls: primaryPotMedian, partnerPotPrePcls: partnerPotMedian,
    percentileData, pctiles, survivalByAge, realIncomeByAge,
    netMonthlyByAge, swrByAge, taxCalc,
    detPotByYear: det.detPotByYear, detCashBalByYear: det.detCashBalByYear, detCashContribByYear: det.detCashContribByYear, returnPct,
    // Accumulation (pre-retirement) arrays — base scenario
    accPensionByYear: det.accPensionByYear, accCashByYear: det.accCashByYear, accYearsToRet: det.accYearsToRet,
    mcRepPaths,
  };

  // Bear / bull deterministic projections (±2%) — for full-range sensitivity lines on the chart
  const bearReturnPct = Math.max(1, returnPct - 2);
  const bullReturnPct = returnPct + 2;
  const bearDet = runDeterministicProjection(Object.assign({}, p, { taxFreeFrac }), bearReturnPct);
  const bullDet = runDeterministicProjection(Object.assign({}, p, { taxFreeFrac }), bullReturnPct);
  if (bearDet) {
    result.bearDetPotByYear = bearDet.detPotByYear;
    result.bearDetCashBalByYear = bearDet.detCashBalByYear;
    result.bearAccPensionByYear = bearDet.accPensionByYear;
    result.bearAccCashByYear = bearDet.accCashByYear;
  }
  if (bullDet) {
    result.bullDetPotByYear = bullDet.detPotByYear;
    result.bullDetCashBalByYear = bullDet.detCashBalByYear;
    result.bullAccPensionByYear = bullDet.accPensionByYear;
    result.bullAccCashByYear = bullDet.accCashByYear;
  }

  result.annualIncomeData = buildAnnualIncomeData(result, 2);
  return result;
}
