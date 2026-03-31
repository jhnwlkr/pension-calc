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
  const stateP = age >= p.spAge ? p.sp : 0;
  return Math.max(0, targetIncome(age, p, cumulInfl) - stateP);
}

export const PCT_LABELS = ['5th', '25th', '50th (Median)', '75th', '95th'];

export function buildAnnualIncomeData(r, pctileIdx) {
  const p = r.p;
  const baseInflFactor = 1 + p.inflation / 100;
  const yearsToRetirement = Math.max(0, p.retirementAge - p.currentAge);
  const currentYear = new Date().getFullYear();
  const startPensionPot = r.startPensionPot || r.startPot;

  const cashBals = r.startCashPotVals ? Float64Array.from(r.startCashPotVals) : new Float64Array(0);
  const result = [];
  for (let yi = 0; yi < r.ages.length; yi++) {
    const age = r.ages[yi];
    const hasStatePension = age >= p.spAge;
    const ci = Math.pow(baseInflFactor, yi);
    const todayDeflator = Math.pow(1 / baseInflFactor, yearsToRetirement + yi);

    const combinedAtPctile = r.percentileData[pctileIdx][yi];
    const cashAtYear = r.cashBalByYear ? r.cashBalByYear[yi] : 0;
    const pensionAtPctile = Math.max(0, combinedAtPctile - cashAtYear);
    const potDepleted = combinedAtPctile <= 0;

    const guardrailActive = p.guardrails && yi > 0 && !potDepleted && pensionAtPctile < startPensionPot * 0.80;
    const guardrailFactor = guardrailActive ? 0.90 : 1.0;

    const reductionFactor = age >= p.reductionAge ? (1 - p.reductionPct / 100) : 1.0;
    const inflFactor = p.drawdownInflation ? ci : 1.0;
    const targetNominal = p.drawdown * inflFactor * reductionFactor;
    const spNominal = hasStatePension ? p.sp : 0;
    const neededFromPots = Math.max(0, targetNominal - spNominal);

    for (let ci2 = 0; ci2 < (p.cashPots || []).length; ci2++) {
      cashBals[ci2] *= (1 + p.cashPots[ci2].interestPct / 100);
    }

    const notionalTcAnn = calcPensionTax(neededFromPots, p.sp, hasStatePension, r.taxFreeFrac);
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

    const otherNet = calcOtherIncomesNet(p.incomes, ci);
    const tc = calcPensionTax(potWithdrawNominal, p.sp, hasStatePension, r.taxFreeFrac);
    const totalNetNominal = cashContrib + tc.pensionNet + (hasStatePension ? tc.spNet : 0) + otherNet.netTotal;

    const potBalNom = pensionAtPctile;
    const potBalReal = pensionAtPctile * todayDeflator;

    const withdrawalNom = cashContrib + potWithdrawNominal;
    const withdrawalReal = withdrawalNom * todayDeflator;

    const prevCombined = yi === 0 ? r.startPot : r.percentileData[pctileIdx][yi - 1];
    const prevCashBal = yi === 0 ? (r.startCashTotal || 0) : (r.cashBalByYear ? r.cashBalByYear[yi - 1] : 0);
    const prevPension = Math.max(0, prevCombined - prevCashBal);
    const pensionInitialValues = p.pots.reduce((s, pot) => s + pot.value, 0);
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
      spNom: hasStatePension ? tc.spNet / 12 : 0,
      otherNom: otherNet.netTotal / 12,
      netNom: totalNetNominal / 12,
      pensionReal: (tc.pensionNet * todayDeflator) / 12,
      spReal: hasStatePension ? (tc.spNet * todayDeflator) / 12 : 0,
      otherReal: (otherNet.netTotal * todayDeflator) / 12,
      netReal: (totalNetNominal * todayDeflator) / 12,
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
      guardrailActive,
      isSpStart: age === p.spAge,
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

  const yearsToRetirement = Math.max(0, p.retirementAge - p.currentAge);

  const numPots = p.pots.length;
  const startPotsPerRun = Array.from({ length: nRuns }, () => new Float64Array(numPots));

  if (yearsToRetirement === 0) {
    for (let r = 0; r < nRuns; r++) {
      p.pots.forEach((pot, pi) => { startPotsPerRun[r][pi] = Math.max(0, pot.value); });
    }
  } else {
    for (let r = 0; r < nRuns; r++) {
      p.pots.forEach((pot, pi) => {
        let val = pot.value;
        const eq = pot.equityPct / 100;
        for (let y = 0; y < yearsToRetirement; y++) {
          val = val * historicalReturn(eq) + pot.annualContrib;
        }
        startPotsPerRun[r][pi] = Math.max(0, val);
      });
    }
  }

  const numCashPots = p.cashPots.length;
  const startCashPotVals = new Float64Array(numCashPots);
  p.cashPots.forEach((cp, ci) => {
    let val = cp.value;
    const rate = 1 + cp.interestPct / 100;
    for (let y = 0; y < yearsToRetirement; y++) val *= rate;
    startCashPotVals[ci] = Math.max(0, val);
  });

  const startTotals = new Float64Array(nRuns);
  for (let r = 0; r < nRuns; r++) {
    let tot = 0;
    for (let pi = 0; pi < numPots; pi++) tot += startPotsPerRun[r][pi];
    startTotals[r] = tot;
  }
  const sortedSP = Float64Array.from(startTotals).sort();
  const startPensionPot = sortedSP[Math.floor(nRuns / 2)];
  const startCashTotal = startCashPotVals.reduce((s, v) => s + v, 0);
  const startPot = startPensionPot + startCashTotal;

  const effectiveDrawdown = p.drawdownMode === 'pct'
    ? startPot * p.drawdownPct / 100
    : p.drawdown;
  p = Object.assign({}, p, { drawdown: effectiveDrawdown });

  const taxFreeFrac = startPensionPot > 0 ? Math.min(0.25, LSA / startPensionPot) : 0.25;
  const potsOrder = p.pots.map((pot, idx) => idx).sort((a, b) => p.pots[a].equityPct - p.pots[b].equityPct);

  const medianPotVals = p.pots.map((pot, pi) => {
    const vals = Array.from({ length: nRuns }, (_, r) => startPotsPerRun[r][pi]).sort((a, b) => a - b);
    return vals[Math.floor(nRuns / 2)];
  });
  const totalMedianVal = medianPotVals.reduce((s, v) => s + v, 0);
  const weightedEquityW = totalMedianVal > 0
    ? p.pots.reduce((s, pot, pi) => s + (medianPotVals[pi] / totalMedianVal) * (pot.equityPct / 100), 0)
    : (p.pots[0]?.equityPct || 80) / 100;

  const potMatrix = Array.from({ length: nRuns }, () => new Float64Array(years + 1));
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
        const eq = p.pots[origIdx].equityPct / 100;
        const ret = 1 + (eq * eqRetYear + (1 - eq) * bdRetYear) / 100;
        const w = totalForBlend > 0 ? runPots[rank] / totalForBlend : 1 / numPots;
        blendedRet += w * ret;
        runPots[rank] = runPots[rank] * ret;
      }

      const inflThisYear = stochasticInflation(p.inflation, blendedRet);
      cumulInfl *= (1 + inflThisYear);
      const pensionTotalAfterGrowth = runPots.reduce((s, v) => s + v, 0);

      const pensionOnlyStart = startTotals[r];
      const guardrailActive = p.guardrails && pensionTotalAfterGrowth < pensionOnlyStart * 0.80;
      if (guardrailActive) guardrailEverTriggered = true;

      const reductionFactor = age >= p.reductionAge ? (1 - p.reductionPct / 100) : 1.0;
      const inflFactor = p.drawdownInflation ? cumulInfl : 1.0;
      const targetNominal = p.drawdown * inflFactor * reductionFactor;
      const hasSPthisYear = age >= p.spAge;
      const spNominal = hasSPthisYear ? p.sp : 0;
      const grossWithdrawal = Math.max(0, targetNominal - spNominal);

      const notionalTc = calcPensionTax(grossWithdrawal, p.sp, hasSPthisYear, taxFreeFrac);
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

  const prob = (successCount / nRuns) * 100;
  const guardrailPct = (guardrailTriggerCount / nRuns) * 100;
  const baseInflFactor = 1 + p.inflation / 100;
  const realDeflatorRetirement = Math.pow(1 / baseInflFactor, yearsToRetirement);
  // Median pot at target (retirement) age, adjusted to today's money
  const medianReal = percentileData[2][yearsToRetirement] * realDeflatorRetirement;

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
      const reductionFactor = age >= p.reductionAge ? (1 - p.reductionPct / 100) : 1.0;
      const inflFactor = p.drawdownInflation ? Math.pow(inflF, y) : 1.0;
      const hasSP = age >= p.spAge;
      const spNom = hasSP ? p.sp : 0;
      const grossNeeded = Math.max(0, p.drawdown * inflFactor * reductionFactor - spNom);
      const ntc = calcPensionTax(grossNeeded, p.sp, hasSP, taxFreeFrac);
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

  const hasSpAtRetirement = p.retirementAge >= p.spAge;
  const cashAtRetirement = cashContribByYear[0] || 0;
  const grossNeededRet = potWithdrawal(p.retirementAge, p, 1.0);
  const potWAtRetirement = pensionGrossAfterCash(grossNeededRet, cashAtRetirement, hasSpAtRetirement);
  taxCalc = calcPensionTax(potWAtRetirement, p.sp, hasSpAtRetirement, taxFreeFrac);
  const otherAtRetirement = calcOtherIncomesNet(p.incomes, 1.0);
  netMonthly = (cashAtRetirement + taxCalc.pensionNet + (hasSpAtRetirement ? taxCalc.spNet : 0) + otherAtRetirement.netTotal) / 12;

  function pensionGrossAfterCash(grossNeeded, cashC, hasSP) {
    const ntc = calcPensionTax(grossNeeded, p.sp, hasSP, taxFreeFrac);
    const netTarget = ntc.pensionNet;
    const cashUsed = Math.min(cashC, netTarget);
    const remainingNet = Math.max(0, netTarget - cashUsed);
    return netTarget > 0 ? remainingNet * (grossNeeded / netTarget) : 0;
  }

  const realIncomeByAge = ages.map((age, yi) => {
    const hasStatePension = age >= p.spAge;
    const ci = Math.pow(baseInflFactor, yi);
    const otherNet = calcOtherIncomesNet(p.incomes, ci);
    const cashC = cashContribByYear[yi] || 0;
    const grossNeeded = potWithdrawal(age, p, ci);
    const potW = pensionGrossAfterCash(grossNeeded, cashC, hasStatePension);
    const stateP = hasStatePension ? p.sp : 0;
    const tc = calcPensionTax(potW, p.sp, hasStatePension, taxFreeFrac);
    const realF = Math.pow(1 / baseInflFactor, yi);
    return {
      age,
      gross: (cashC + potW + stateP + otherNet.grossTotal) * realF,
      net: (cashC + tc.pensionNet + (hasStatePension ? tc.spNet : 0) + otherNet.netTotal) * realF
    };
  });

  const netMonthlyByAge = ages.map((age, yi) => {
    const hasStatePension = age >= p.spAge;
    const ci = Math.pow(baseInflFactor, yi);
    const otherNet = calcOtherIncomesNet(p.incomes, ci);
    const cashC = cashContribByYear[yi] || 0;
    const grossNeeded = potWithdrawal(age, p, ci);
    const potW = pensionGrossAfterCash(grossNeeded, cashC, hasStatePension);
    const tc = calcPensionTax(potW, p.sp, hasStatePension, taxFreeFrac);
    const realF = Math.pow(1 / baseInflFactor, yi);
    return {
      age,
      cash: (cashC * realF) / 12,
      pension: (tc.pensionNet * realF) / 12,
      sp: hasStatePension ? (tc.spNet * realF) / 12 : 0,
      other: (otherNet.netTotal * realF) / 12
    };
  });

  const result = {
    ages, years, p, prob, guardrailPct, medianReal,
    swrPct, swr, netMonthly, startPot, startPensionPot, startCashTotal,
    startCashPotVals, cashContribByYear, cashBalByYear, taxFreeFrac,
    percentileData, pctiles, survivalByAge, realIncomeByAge,
    netMonthlyByAge, swrByAge, taxCalc
  };
  result.annualIncomeData = buildAnnualIncomeData(result, 2);
  return result;
}
