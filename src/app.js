import { fmt, fmtGBP, fmtPct, fmtAxisGBP } from './utils.js';
import { LSA, FORMER_LTA } from './constants.js';
import { incomeTax, calcPensionTax, calcOtherIncomesNet } from './model.js';
import { runSimulation as runSimulationImpl } from './simulation.js';

// ── Dynamic Pots State ─────────────────────────────────────────────────────
let nextPotId = 1;
let potsData = [];
let todayPrices = false; // Shared today’s-prices toggle state


function addPot(value, annualContrib, equityPct) {
  const id = nextPotId++;
  potsData.push({
    id,
    value: (value !== undefined && value !== null) ? +value : 0,
    annualContrib: (annualContrib !== undefined && annualContrib !== null) ? +annualContrib : 0,
    equityPct: (equityPct !== undefined && equityPct !== null) ? +equityPct : 80,
  });
  renderPotsUI();
}

function removePot(id) {
  if (potsData.length <= 1) return; // keep at least one
  potsData = potsData.filter(p => p.id !== id);
  renderPotsUI();
  persistParams();
}

function renderPotsUI() {
  const container = document.getElementById('pots-container');
  container.innerHTML = '';
  potsData.forEach((pot, idx) => {
    const div = document.createElement('div');
    div.className = 'pot-card';
    div.innerHTML = `
      <div class="pot-card-header">
        <span class="pot-card-title">Pot ${idx + 1}</span>
        ${potsData.length > 1 ? `<button class="remove-btn" data-pot-id="${pot.id}">✕</button>` : ''}
      </div>
      <div class="two-col" style="margin-bottom:8px">
        <div>
          <span class="field-label">Current value</span>
          <div class="input-group">
            <span class="input-prefix">£</span>
            <input class="dyn-input" type="number" min="0" step="1000" data-pot-id="${pot.id}" data-field="value" value="${pot.value}">
          </div>
        </div>
        <div>
          <span class="field-label">Annual contribution</span>
          <div class="input-group">
            <span class="input-prefix">£</span>
            <input class="dyn-input" type="number" min="0" step="100" data-pot-id="${pot.id}" data-field="annualContrib" value="${pot.annualContrib}">
          </div>
        </div>
      </div>
      <div>
        <div class="slider-label" style="margin-bottom:4px">
          <span class="slider-name">Equity / Bond</span>
          <span class="slider-val" id="v-pot-equity-${pot.id}">${pot.equityPct}% / ${100 - pot.equityPct}%</span>
        </div>
        <input type="range" min="0" max="100" step="5" value="${pot.equityPct}" data-pot-id="${pot.id}" data-field="equityPct" class="pot-equity-slider">
      </div>`;
    container.appendChild(div);
  });

  // Wire remove buttons
  container.querySelectorAll('.remove-btn[data-pot-id]').forEach(btn => {
    btn.addEventListener('click', () => removePot(+btn.dataset.potId));
  });

  // Wire number inputs
  container.querySelectorAll('.dyn-input[data-pot-id]').forEach(inp => {
    inp.addEventListener('input', () => {
      const potId = +inp.dataset.potId;
      const field = inp.dataset.field;
      const pot = potsData.find(p => p.id === potId);
      if (pot) { pot[field] = +inp.value; }
      persistParams();
    });
  });

  // Wire equity sliders
  container.querySelectorAll('.pot-equity-slider').forEach(slider => {
    slider.addEventListener('input', () => {
      const potId = +slider.dataset.potId;
      const pot = potsData.find(p => p.id === potId);
      if (pot) {
        pot.equityPct = +slider.value;
        const lbl = document.getElementById('v-pot-equity-' + potId);
        if (lbl) lbl.textContent = pot.equityPct + '% / ' + (100 - pot.equityPct) + '%';
      }
      persistParams();
    });
  });
}

// Dynamic control wiring is done in initApp() to avoid DOM timing issues when the script is loaded.

// ── Dynamic Incomes State ──────────────────────────────────────────────────
let nextIncomeId = 1;
let incomesData = [];

function addIncome(name, amount, frequency, taxPct, inflationLinked = false) {
  const id = nextIncomeId++;
  incomesData.push({
    id,
    name: name || 'Income source',
    amount: amount !== undefined ? amount : 0,
    frequency: frequency || 'annual',
    taxPct: taxPct !== undefined ? taxPct : 20,
    inflationLinked,
  });
  renderIncomesUI();
}

function removeIncome(id) {
  incomesData = incomesData.filter(inc => inc.id !== id);
  renderIncomesUI();
  persistParams();
}

function renderIncomesUI() {
  const container = document.getElementById('incomes-container');
  container.innerHTML = '';
  if (incomesData.length === 0) {
    container.innerHTML = '<div style="font-size:0.78rem;color:var(--text2);padding:6px 0">No other income sources added.</div>';
    return;
  }
  incomesData.forEach(inc => {
    const div = document.createElement('div');
    div.className = 'income-card';
    div.innerHTML = `
      <div class="income-card-header">
        <div class="input-group" style="flex:1;margin-right:6px">
          <input class="dyn-input" type="text" placeholder="Name" data-inc-id="${inc.id}" data-field="name" value="${inc.name.replace(/"/g,'&quot;')}" style="font-weight:600">
        </div>
        <button class="remove-btn" data-inc-id="${inc.id}">✕</button>
      </div>
      <div class="two-col">
        <div>
          <span class="field-label">Amount</span>
          <div class="input-group">
            <span class="input-prefix">£</span>
            <input class="dyn-input" type="number" min="0" step="100" data-inc-id="${inc.id}" data-field="amount" value="${inc.amount}">
          </div>
        </div>
        <div>
          <span class="field-label">Frequency</span>
          <select class="dyn-select" data-inc-id="${inc.id}" data-field="frequency">
            <option value="annual" ${inc.frequency === 'annual' ? 'selected' : ''}>Annual</option>
            <option value="monthly" ${inc.frequency === 'monthly' ? 'selected' : ''}>Monthly</option>
          </select>
        </div>
        <div>
          <span class="field-label">Tax rate</span>
          <div class="input-group">
            <input class="dyn-input" type="number" min="0" max="100" step="1" data-inc-id="${inc.id}" data-field="taxPct" value="${inc.taxPct}" style="text-align:right">
            <span class="input-suffix">%</span>
          </div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;margin-top:6px">
        <input type="checkbox" data-inc-id="${inc.id}" data-field="inflationLinked" ${inc.inflationLinked ? 'checked' : ''} style="cursor:pointer;width:14px;height:14px">
        <span style="font-size:0.78rem;color:var(--text2)">Increases with inflation</span>
      </div>`;
    container.appendChild(div);
  });

  // Wire remove buttons
  container.querySelectorAll('.remove-btn[data-inc-id]').forEach(btn => {
    btn.addEventListener('click', () => removeIncome(+btn.dataset.incId));
  });

  // Wire inputs
  container.querySelectorAll('[data-inc-id]').forEach(el => {
    const evName = (el.tagName === 'SELECT' || el.type === 'checkbox') ? 'change' : 'input';
    el.addEventListener(evName, () => {
      const incId = +el.dataset.incId;
      const field = el.dataset.field;
      const inc = incomesData.find(i => i.id === incId);
      if (inc) {
        if (field === 'inflationLinked') inc[field] = el.checked;
        else if (field === 'name' || field === 'frequency') inc[field] = el.value;
        else inc[field] = +el.value;
      }
      persistParams();
    });
  });
}

// add-income button wiring is initialized in initApp().

// ── Dynamic Cash Pots State ────────────────────────────────────────────────
let nextCashPotId = 1;
let cashPotsData = [];

function addCashPot(value, interestPct) {
  const id = nextCashPotId++;
  cashPotsData.push({
    id,
    value: (value !== undefined && value !== null) ? +value : 0,
    interestPct: (interestPct !== undefined && interestPct !== null) ? +interestPct : 3.5,
  });
  renderCashPotsUI();
}

function removeCashPot(id) {
  cashPotsData = cashPotsData.filter(p => p.id !== id);
  renderCashPotsUI();
  persistParams();
}

function renderCashPotsUI() {
  const container = document.getElementById('cash-pots-container');
  container.innerHTML = '';
  if (cashPotsData.length === 0) {
    container.innerHTML = '<div style="font-size:0.78rem;color:var(--text2);padding:6px 0">No cash pots added.</div>';
    return;
  }
  cashPotsData.forEach((pot, idx) => {
    const div = document.createElement('div');
    div.className = 'pot-card';
    div.innerHTML = `
      <div class="pot-card-header">
        <span class="pot-card-title">Cash Pot ${idx + 1}</span>
        <button class="remove-btn" data-cash-pot-id="${pot.id}">✕</button>
      </div>
      <div class="two-col">
        <div>
          <span class="field-label">Current value</span>
          <div class="input-group">
            <span class="input-prefix">£</span>
            <input class="dyn-input" type="number" min="0" step="1000" data-cash-pot-id="${pot.id}" data-field="value" value="${pot.value}">
          </div>
        </div>
        <div>
          <span class="field-label">Interest rate</span>
          <div class="input-group">
            <input class="dyn-input" type="number" min="0" max="20" step="0.1" data-cash-pot-id="${pot.id}" data-field="interestPct" value="${pot.interestPct}" style="text-align:right">
            <span class="input-suffix">%</span>
          </div>
        </div>
      </div>`;
    container.appendChild(div);
  });

  container.querySelectorAll('.remove-btn[data-cash-pot-id]').forEach(btn => {
    btn.addEventListener('click', () => removeCashPot(+btn.dataset.cashPotId));
  });

  container.querySelectorAll('.dyn-input[data-cash-pot-id]').forEach(inp => {
    inp.addEventListener('input', () => {
      const potId = +inp.dataset.cashPotId;
      const field = inp.dataset.field;
      const pot = cashPotsData.find(p => p.id === potId);
      if (pot) { pot[field] = +inp.value; }
      persistParams();
    });
  });
}

// add-cash-pot button wiring is initialized in initApp().

// ── Slider wiring ──────────────────────────────────────────────────────────
function getParams() {
  return {
    currentAge: +document.getElementById('current-age').value,
    retirementAge: +document.getElementById('retirement-age').value,
    endAge: +document.getElementById('end-age').value,
    spAge: +document.getElementById('sp-age').value,
    reductionAge: +document.getElementById('reduction-age').value,
    reductionPct: +document.getElementById('reduction-pct').value,
    drawdown: +document.getElementById('drawdown').value,
    sp: +document.getElementById('sp').value,
    inflation: +document.getElementById('inflation').value,
    runs: +document.getElementById('runs').value,
    guardrails: document.getElementById('guardrails').checked,
    drawdownMode: document.querySelector('input[name="drawdown-mode"]:checked')?.value || 'amount',
    drawdownPct: +document.getElementById('drawdown-pct').value,
    drawdownInflation: document.getElementById('drawdown-inflation').checked,
    pots: potsData.map(p => Object.assign({}, p)),
    incomes: incomesData.map(i => Object.assign({}, i)),
    cashPots: cashPotsData.map(p => Object.assign({}, p)),
  };
}

function sanitizeParams() {
  const current = document.getElementById('current-age');
  const retire = document.getElementById('retirement-age');
  const end = document.getElementById('end-age');
  if (!current || !retire || !end) return;
  const currentAge = +current.value;
  let retirementAge = +retire.value;
  let endAge = +end.value;

  if (retirementAge <= currentAge) {
    retirementAge = currentAge + 1;
    retire.value = retirementAge;
    document.getElementById('v-retirement-age').textContent = retirementAge;
  }
  if (endAge <= retirementAge) {
    endAge = Math.max(retirementAge + 5, retirementAge + 1);
    end.value = endAge;
    document.getElementById('v-end-age').textContent = endAge;
  }
}

function chartAvailable() {
  return typeof Chart !== 'undefined';
}

function isTodayMoney() {
  return todayPrices;
}

function setTodayMoney(checked, r) {
  todayPrices = checked;
  document.querySelectorAll('.today-money-toggle').forEach(cb => { cb.checked = checked; });
  if (r) {
    // re-render current active view immediately
    const tab = document.querySelector('.tab.active')?.dataset.tab || 'pot';
    if (tab === 'pot') renderPotChart(r);
    else if (tab === 'swr') renderSWRChart(r);
    else if (tab === 'survival') renderSurvivalChart(r);
    else if (tab === 'realincome') renderRealIncomeChart(r);
    else if (tab === 'netmonthly') renderNetMonthlyChart(r);
    else if (tab === 'annualincome') renderAnnualIncomeChart(r);
    else if (tab === 'monthlybreakdown') renderIncomeTable(r);
  }
}

const sliders = [
  ['current-age', v => v, ''], ['retirement-age', v => v, ''],
  ['end-age', v => v, ''], ['sp-age', v => v, ''],
  ['reduction-age', v => v, ''], ['reduction-pct', v => fmtPct(v), ''],
  ['drawdown', v => fmtGBP(v), ''], ['drawdown-pct', v => fmtPct(+v, 2), ''],
  ['sp', v => fmtGBP(v), ''], ['inflation', v => fmtPct(v), ''],
  ['runs', v => fmt(v), ''],
];
sliders.forEach(([id, formatter]) => {
  const el = document.getElementById(id);
  const label = document.getElementById('v-' + id);
  el.addEventListener('input', () => { label.textContent = formatter(+el.value); persistParams(); });
});

// ── Persistence ────────────────────────────────────────────────────────────
const LS_KEY = 'pension-forecast-v6';
const SLIDER_IDS = sliders.map(([id]) => id);

function persistParams() {
  const obj = {};
  SLIDER_IDS.forEach(id => { obj[id] = document.getElementById(id).value; });
  obj['guardrails'] = document.getElementById('guardrails').checked ? '1' : '0';
  obj['today-money'] = isTodayMoney() ? '1' : '0';
  obj['drawdown-mode'] = document.querySelector('input[name="drawdown-mode"]:checked')?.value || 'amount';
  obj['drawdown-inflation'] = document.getElementById('drawdown-inflation').checked ? '1' : '0';
  obj['pots'] = JSON.stringify(potsData);
  obj['incomes'] = JSON.stringify(incomesData);
  obj['cashPots'] = JSON.stringify(cashPotsData);
  try { localStorage.setItem(LS_KEY, JSON.stringify(obj)); } catch(e) {}
  // URL hash only for slider values (pots/incomes too complex)
  const urlObj = {};
  SLIDER_IDS.forEach(id => { urlObj[id] = obj[id]; });
  urlObj['guardrails'] = obj['guardrails'];
  urlObj['drawdown-mode'] = obj['drawdown-mode'];
  urlObj['drawdown-inflation'] = obj['drawdown-inflation'];
  history.replaceState(null, '', '#' + new URLSearchParams(urlObj).toString());
}

function loadPersistedParams() {
  // URL hash only for sliders (not pots/incomes)
  if (location.hash.length > 1) {
    try {
      const obj = Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
      if (Object.keys(obj).length > 0) {
        // Also check localStorage for pots/incomes
        try {
          const raw = localStorage.getItem(LS_KEY);
          if (raw) {
            const ls = JSON.parse(raw);
            if (ls['pots']) obj['pots'] = ls['pots'];
            if (ls['incomes']) obj['incomes'] = ls['incomes'];
            if (ls['cashPots']) obj['cashPots'] = ls['cashPots'];
          }
        } catch(e) {}
        return obj;
      }
    } catch(e) {}
  }
  try { const raw = localStorage.getItem(LS_KEY); if (raw) return JSON.parse(raw); } catch(e) {}
  return null;
}

function restoreParams(obj) {
  SLIDER_IDS.forEach(id => {
    if (obj[id] === undefined) return;
    const el = document.getElementById(id);
    el.value = obj[id];
    el.dispatchEvent(new Event('input'));
  });
  if (obj['guardrails'] !== undefined) {
    document.getElementById('guardrails').checked = obj['guardrails'] !== '0';
  }
  if (obj['drawdown-mode']) {
    const modeEl = document.getElementById('dm-' + obj['drawdown-mode']);
    if (modeEl) { modeEl.checked = true; updateDrawdownMode(obj['drawdown-mode']); }
  }
  if (obj['drawdown-inflation'] !== undefined) {
    document.getElementById('drawdown-inflation').checked = obj['drawdown-inflation'] !== '0';
  }
  if (obj['today-money'] !== undefined) {
    const checked = obj['today-money'] !== '0';
    setTodayMoney(checked, null);
  }
  // Restore pots
  if (obj['pots']) {
    try {
      const saved = JSON.parse(obj['pots']);
      if (Array.isArray(saved) && saved.length > 0) {
        potsData = [];
        saved.forEach(p => {
          const id = nextPotId++;
          potsData.push({ id, value: +p.value || 0, annualContrib: +p.annualContrib || 0, equityPct: p.equityPct !== undefined ? +p.equityPct : 80 });
        });
        renderPotsUI();
      }
    } catch(e) {}
  }
  // Restore incomes
  if (obj['incomes']) {
    try {
      const saved = JSON.parse(obj['incomes']);
      if (Array.isArray(saved)) {
        incomesData = [];
        saved.forEach(inc => {
          const id = nextIncomeId++;
          incomesData.push({ id, name: inc.name || 'Income source', amount: inc.amount || 0, frequency: inc.frequency || 'annual', taxPct: inc.taxPct !== undefined ? inc.taxPct : 20, inflationLinked: inc.inflationLinked === true });
        });
        renderIncomesUI();
      }
    } catch(e) {}
  }
  // Restore cash pots
  if (obj['cashPots']) {
    try {
      const saved = JSON.parse(obj['cashPots']);
      if (Array.isArray(saved)) {
        cashPotsData = [];
        saved.forEach(p => {
          const id = nextCashPotId++;
          cashPotsData.push({ id, value: +p.value || 0, interestPct: p.interestPct !== undefined ? +p.interestPct : 3.5 });
        });
        renderCashPotsUI();
      }
    } catch(e) {}
  }
}

// ── Drawdown mode UI toggle ────────────────────────────────────────────────
function updateDrawdownMode(mode) {
  document.getElementById('drawdown-amount-row').classList.toggle('hidden', mode !== 'amount');
  document.getElementById('drawdown-pct-row').classList.toggle('hidden', mode !== 'pct');
}

function targetIncome(age, p, cumulInfl) {
  const reductionFactor = age >= p.reductionAge ? (1 - p.reductionPct / 100) : 1.0;
  const inflFactor = p.drawdownInflation !== false ? cumulInfl : 1.0;
  return p.drawdown * inflFactor * reductionFactor;
}

function potWithdrawal(age, p, cumulInfl) {
  const stateP = age >= p.spAge ? p.sp : 0;
  return Math.max(0, targetIncome(age, p, cumulInfl) - stateP);
}

const PCT_LABELS = ['5th', '25th', '50th (Median)', '75th', '95th'];

function buildAnnualIncomeData(r, pctileIdx) {
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
    const ciFromNow = Math.pow(baseInflFactor, yearsToRetirement + yi);
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

    const otherNet = calcOtherIncomesNet(p.incomes, ciFromNow);
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

// ── Simulation ─────────────────────────────────────────────────────────────
let lastResults = null;
let charts = {};

function runSimulation() {
  sanitizeParams();
  const r = runSimulationImpl(getParams());
  lastResults = r;
  return r;
}

// ── Render Cards ───────────────────────────────────────────────────────────
function renderCards(r) {
  const probEl = document.getElementById('c-prob');
  probEl.textContent = r.prob.toFixed(1) + '%';
  probEl.className = 'card-value ' + (r.prob >= 90 ? 'green' : r.prob >= 70 ? 'amber' : 'red');

  document.getElementById('c-guardrail-sub').textContent = r.p.guardrails
    ? `pot survives · guardrail in ${r.guardrailPct.toFixed(0)}% of runs`
    : 'pot survives · guardrails off';

  document.getElementById('c-median').textContent = fmtGBP(r.medianReal);

  const swrEl = document.getElementById('c-swr');
  swrEl.textContent = fmtPct(r.swrPct);
  swrEl.className = 'card-value ' + (r.swrPct >= 4 ? 'green' : r.swrPct >= 3 ? 'amber' : 'red');

  const actualRatePct = r.startPot > 0 ? (r.p.drawdown / r.startPot) * 100 : 0;
  const actualEl = document.getElementById('c-actual-rate');
  actualEl.textContent = fmtPct(actualRatePct);
  actualEl.className = actualRatePct <= r.swrPct ? 'green' : actualRatePct <= r.swrPct * 1.2 ? 'amber' : 'red';

  document.getElementById('c-monthly').textContent = fmtGBP(r.netMonthly, 0);
  const cMonthlySub = document.getElementById('c-monthly-sub');
  if (cMonthlySub) {
    cMonthlySub.innerHTML = `at retirement (after tax)<br>
      <span style="display:block;font-size:0.72rem;color:var(--text2)">Gross monthly: ${fmtGBP(r.grossMonthly, 0)}</span>
      <span style="display:block;font-size:0.72rem;color:var(--text2)">Net annual: ${fmtGBP(r.netAnnual, 0)}</span>
      <span style="display:block;font-size:0.72rem;color:var(--text2)">Gross annual: ${fmtGBP(r.grossAnnual, 0)}</span>`;
  }

  const lsaAlert = document.getElementById('lsa-alert');
  lsaAlert.classList.toggle('hidden', r.startPot <= FORMER_LTA);
}

// ── Render Income Table ────────────────────────────────────────────────────
function renderIncomeTable(r) {
  const p = r.p;
  const taxFreeFrac = r.taxFreeFrac;
  const baseInfl = 1 + p.inflation / 100;

  // Helper: deterministically simulate cash pot contribution at a given year index
  function cashContribAtYear(targetYearIdx) {
    const bals = r.startCashPotVals ? Float64Array.from(r.startCashPotVals) : new Float64Array(0);
    function drainYear(y) {
      const age = p.retirementAge + y;
      for (let ci = 0; ci < bals.length; ci++) bals[ci] *= (1 + p.cashPots[ci].interestPct / 100);
      const inflF = p.drawdownInflation ? Math.pow(baseInfl, y) : 1.0;
      const redF = age >= p.reductionAge ? (1 - p.reductionPct / 100) : 1.0;
      const hasSP = age >= p.spAge;
      const spN = hasSP ? p.sp * Math.pow(baseInfl, y) : 0;
      const grossNeeded = Math.max(0, p.drawdown * inflF * redF - spN);
      const ntc = calcPensionTax(grossNeeded, spN, hasSP, taxFreeFrac);
      const netTarget = ntc.pensionNet;
      let remaining = netTarget;
      for (let ci = 0; ci < bals.length && remaining > 0; ci++) {
        const take = Math.min(bals[ci], remaining); bals[ci] -= take; remaining -= take;
      }
      return netTarget - remaining;
    }
    for (let y = 0; y < targetYearIdx; y++) drainYear(y);
    return drainYear(targetYearIdx);
  }

  const yearsToRetirement = Math.max(0, p.retirementAge - p.currentAge);
  const isToday = isTodayMoney();
  const factor1 = isToday ? 1 / Math.pow(baseInfl, yearsToRetirement) : 1;
  const spYears = Math.max(0, p.spAge - p.retirementAge);
  const factor2 = isToday ? 1 / Math.pow(baseInfl, yearsToRetirement + spYears) : 1;
  const hasSpAtReduction = p.reductionAge >= p.spAge;
  const redYears = Math.max(0, p.reductionAge - p.retirementAge);
  const factor3 = isToday ? 1 / Math.pow(baseInfl, yearsToRetirement + redYears) : 1;
  const ci0 = 1.0;
  const ci2 = Math.pow(baseInfl, spYears);
  const ci3 = Math.pow(baseInfl, redYears);

  // Cash contributions at each snapshot (NET values — cash is post-tax)
  const cash1 = cashContribAtYear(0);
  const cash2 = cashContribAtYear(spYears);
  const cash3 = cashContribAtYear(redYears);

  // Helper: gross-up pension withdrawal after cash covers the net shortfall
  function pensionGrossTable(grossNeeded, cashNet, hasSP, spInfl = 0) {
    const ntc = calcPensionTax(grossNeeded, spInfl, hasSP, taxFreeFrac);
    const netTarget = ntc.pensionNet;
    const cashUsed = Math.min(cashNet, netTarget);
    const remainingNet = Math.max(0, netTarget - cashUsed);
    return netTarget > 0 ? remainingNet * (grossNeeded / netTarget) : 0;
  }

  // Inflated state pension at each snapshot
  const sp1 = 0;           // no state pension at retirement (column 1 assumes pre-SP)
  const sp2 = p.sp * ci2;  // state pension at SP start age, in nominal terms
  const sp3 = hasSpAtReduction ? p.sp * ci3 : 0;

  // Column 1: at retirement (no state pension yet)
  const gross1 = Math.max(0, p.drawdown * ci0);
  const potW1Full = pensionGrossTable(gross1, cash1, false, 0);
  const tc1 = calcPensionTax(potW1Full, 0, false, taxFreeFrac);
  const other1 = calcOtherIncomesNet(p.incomes, ci0);

  // Column 2: once state pension starts
  const gross2 = potWithdrawal(p.spAge, p, ci2); // gross needed from pots after SP (already uses inflated SP)
  const potW2 = pensionGrossTable(gross2, cash2, true, sp2);
  const tc2 = calcPensionTax(potW2, sp2, true, taxFreeFrac);
  const other2 = calcOtherIncomesNet(p.incomes, ci2);

  // Column 3: after income reduction
  const gross3 = potWithdrawal(p.reductionAge, p, ci3);
  const potW3 = pensionGrossTable(gross3, cash3, hasSpAtReduction, sp3);
  const tc3 = calcPensionTax(potW3, sp3, hasSpAtReduction, taxFreeFrac);
  const other3 = calcOtherIncomesNet(p.incomes, ci3);

  document.getElementById('th-after-reduction').innerHTML =
    `After Reduction (age ${p.reductionAge})<br><small style="font-weight:400">Gross / Tax / Net</small>`;

  function cell(gross, tax, net, fact) {
    return `${fmtGBP((gross * fact)/12)} / <span style="color:var(--red)">${fmtGBP((tax * fact)/12)}</span> / <strong>${fmtGBP((net * fact)/12)}</strong>`;
  }
  function row(label, g1,t1,n1, g2,t2,n2, g3,t3,n3, note) {
    return `<tr><td>${label}</td><td>${cell(g1,t1,n1, factor1)}</td><td>${cell(g2,t2,n2, factor2)}</td><td>${cell(g3,t3,n3, factor3)}</td><td>${note}</td></tr>`;
  }

  const lsaBadge = taxFreeFrac < 0.25
    ? `<span class="badge badge-amber">${(taxFreeFrac*100).toFixed(1)}% tax-free (LSA capped)</span>`
    : `<span class="badge badge-green">25% tax-free (within LSA)</span>`;

  const ltaBadge = (r.startPensionPot || r.startPot) > FORMER_LTA
    ? ` <span class="badge badge-warning">⚠ Former LTA exceeded</span>`
    : '';

  let rows = '';

  // Cash pot row (only if any cash pots exist)
  if (p.cashPots && p.cashPots.length > 0) {
    const totalCashStart = (r.startCashPotVals || []).reduce((s, v) => s + v, 0);
    rows += row('Cash pots (drawn first)',
        cash1, 0, cash1,
        cash2, 0, cash2,
        cash3, 0, cash3,
        `Tax-free · ${fmtGBP(totalCashStart)} at retirement`);
  }

  rows += row('Pension (from pot)',
      potW1Full, tc1.pensionTax, tc1.pensionNet,
      potW2, tc2.pensionTax, tc2.pensionNet,
      potW3, tc3.pensionTax, tc3.pensionNet,
      lsaBadge + ltaBadge);

  rows += row('State pension',
      0,0,0, sp2, tc2.spTax, tc2.spNet,
      sp3, sp3 > 0 ? tc3.spTax : 0, sp3 > 0 ? tc3.spNet : 0,
      `From age ${p.spAge}`);

  // Dynamic other income rows
  if (p.incomes.length > 0) {
    p.incomes.forEach(inc => {
      const annAmt = inc.frequency === 'monthly' ? inc.amount * 12 : inc.amount;
      const f1 = inc.inflationLinked ? Math.pow(baseInfl, yearsToRetirement) : 1;
      const f2 = inc.inflationLinked ? Math.pow(baseInfl, yearsToRetirement + spYears) : 1;
      const f3 = inc.inflationLinked ? Math.pow(baseInfl, yearsToRetirement + redYears) : 1;
      const g1i = annAmt * f1, t1i = g1i * (inc.taxPct/100), n1i = g1i - t1i;
      const g2i = annAmt * f2, t2i = g2i * (inc.taxPct/100), n2i = g2i - t2i;
      const g3i = annAmt * f3, t3i = g3i * (inc.taxPct/100), n3i = g3i - t3i;
      const note = `${inc.taxPct}% flat tax · ${inc.inflationLinked ? 'CPI-linked' : 'Fixed'}`;
      rows += row(inc.name, g1i,t1i,n1i, g2i,t2i,n2i, g3i,t3i,n3i, note);
    });
  }

  // Total row
  const tot1g = cash1 + potW1Full + other1.grossTotal, tot1t = tc1.pensionTax + other1.taxTotal, tot1n = cash1 + tc1.pensionNet + other1.netTotal;
  const tot2g = cash2 + potW2 + sp2 + other2.grossTotal, tot2t = tc2.pensionTax + tc2.spTax + other2.taxTotal, tot2n = cash2 + tc2.pensionNet + tc2.spNet + other2.netTotal;
  const spTax3 = sp3 > 0 ? tc3.spTax : 0;
  const spNet3 = sp3 > 0 ? tc3.spNet : 0;
  const tot3g = cash3 + potW3 + sp3 + other3.grossTotal, tot3t = tc3.pensionTax + spTax3 + other3.taxTotal, tot3n = cash3 + tc3.pensionNet + spNet3 + other3.netTotal;

  rows += `<tr>
    <td><strong>Total</strong></td>
    <td>${cell(tot1g, tot1t, tot1n)}</td>
    <td>${cell(tot2g, tot2t, tot2n)}</td>
    <td>${cell(tot3g, tot3t, tot3n)}</td>
    <td></td>
  </tr>`;

  document.getElementById('income-tbody').innerHTML = rows;
}

// ── Render Annual Income Table ─────────────────────────────────────────────
function renderAnnualIncomeTable(r) {
  const tbody = document.getElementById('annual-income-tbody');
  function dualCell(nom, real) {
    return `<td style="text-align:right">${fmtGBP(nom)}<span class="ann-real">${fmtGBP(real)}</span></td>`;
  }
  tbody.innerHTML = r.annualIncomeData.map(d => {
    let cls = '';
    if (d.guardrailActive) cls = 'guardrail-row';
    else if (d.isSpStart) cls = 'sp-start-row';
    const ageLabel = d.age === r.p.retirementAge && r.p.retirementAge > r.p.currentAge
      ? `${d.age}<br><span style="font-size:0.72rem;color:var(--text2)">${d.calYear} · pre-ret. growth →</span>`
      : `${d.age}<br><span style="font-size:0.72rem;color:var(--text2)">${d.calYear}</span>`;
    function growthCell(nom, real) {
      const nomStr  = nom  >= 0 ? fmtGBP(nom)  : `<span style="color:var(--red)">${fmtGBP(nom)}</span>`;
      const realStr = real >= 0 ? fmtGBP(real) : `<span style="color:var(--red)">${fmtGBP(real)}</span>`;
      return `<td style="text-align:right">${nomStr}<span class="ann-real">${realStr}</span></td>`;
    }
    return `<tr class="${cls}">
      <td>${ageLabel}</td>
      ${dualCell(d.cashNom, d.cashReal)}
      ${dualCell(d.pensionNom, d.pensionReal)}
      ${dualCell(d.spNom, d.spReal)}
      ${dualCell(d.otherNom, d.otherReal)}
      ${dualCell(d.netNom, d.netReal)}
      ${dualCell(d.cashWithdrawalNom, d.cashWithdrawalReal)}
      ${dualCell(d.pensionWithdrawalNom, d.pensionWithdrawalReal)}
      ${growthCell(d.growthNom, d.growthReal)}
      ${growthCell(d.netPotChangeNom, d.netPotChangeReal)}
      ${dualCell(d.potBalNom, d.potBalReal)}
    </tr>`;
  }).join('');
}

// ── Chart helpers ──────────────────────────────────────────────────────────
function isDark() { return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; }
function gridColor() { return isDark() ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'; }
function textColor() { return isDark() ? '#9ca3af' : '#6b7280'; }
function destroyChart(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }

// ── Pot Chart ──────────────────────────────────────────────────────────────
function renderPotChart(r) {
  if (!chartAvailable()) return;
  destroyChart('pot');
  const chartEl = document.getElementById('chart-pot');
  if (!chartEl) return;
  const ctx = chartEl.getContext('2d');
  const [p5, p25, p50, p75, p95] = r.percentileData;
  const spAgeIdx = r.ages.indexOf(r.p.spAge);
  const useToday = isTodayMoney();
  const baseInflFactor = 1 + (r.p?.inflation || 0) / 100;
  const yearsToRetirement = Math.max(0, r.p.retirementAge - r.p.currentAge);
  const deflator = i => Math.pow(1 / baseInflFactor, yearsToRetirement + i);

  const mapSeries = (arr) => Array.from(arr).map((v, i) => useToday ? v * deflator(i) : v);

  const spLinePlugin = {
    id: 'spLine',
    afterDraw(chart) {
      if (spAgeIdx < 0) return;
      const { ctx: c, scales: { x, y } } = chart;
      const xPx = x.getPixelForValue(spAgeIdx);
      c.save();
      c.strokeStyle = '#d97706';
      c.lineWidth = 1.5;
      c.setLineDash([6, 4]);
      c.beginPath(); c.moveTo(xPx, y.top); c.lineTo(xPx, y.bottom); c.stroke();
      c.fillStyle = '#d97706';
      c.font = '11px system-ui,sans-serif';
      c.textAlign = 'left';
      c.fillText('State Pension', xPx + 4, y.top + 14);
      c.restore();
    }
  };

  charts['pot'] = new Chart(ctx, {
    type: 'line',
    plugins: [spLinePlugin],
    data: {
      labels: r.ages,
      datasets: [
        { label: '95th', data: mapSeries(p95), borderColor: 'rgba(37,99,235,0.2)', backgroundColor: 'rgba(37,99,235,0.08)', fill: '+1', tension: 0.3, pointRadius: 0, borderWidth: 1 },
        { label: '75th', data: mapSeries(p75), borderColor: 'rgba(37,99,235,0.4)', backgroundColor: 'rgba(37,99,235,0.12)', fill: '+1', tension: 0.3, pointRadius: 0, borderWidth: 1 },
        { label: 'Median', data: mapSeries(p50), borderColor: 'rgba(37,99,235,1)', backgroundColor: 'transparent', fill: false, tension: 0.3, pointRadius: 0, borderWidth: 2 },
        { label: '25th', data: mapSeries(p25), borderColor: 'rgba(37,99,235,0.4)', backgroundColor: 'rgba(37,99,235,0.12)', fill: '+1', tension: 0.3, pointRadius: 0, borderWidth: 1 },
        { label: '5th', data: mapSeries(p5), borderColor: 'rgba(37,99,235,0.2)', backgroundColor: 'rgba(37,99,235,0.08)', fill: false, tension: 0.3, pointRadius: 0, borderWidth: 1 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: textColor(), font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: textColor() }, grid: { color: gridColor() }, title: { display: true, text: 'Age', color: textColor() } },
        y: { ticks: { color: textColor(), callback: v => fmtAxisGBP(v) }, grid: { color: gridColor() }, title: { display: true, text: useToday ? 'Pot Value (£, today\'s money)' : 'Pot Value (£, nominal)', color: textColor() } }
      }
    }
  });
}

function renderSWRChart(r) {
  if (!chartAvailable()) return;
  destroyChart('swr');
  const chartEl = document.getElementById('chart-swr');
  if (!chartEl) return;
  const ctx = chartEl.getContext('2d');
  const labels = r.swrByAge.map(d => 'Age ' + d.age);
  const vals = r.swrByAge.map(d => +d.pct.toFixed(2));
  const colors = vals.map(v => v >= 4 ? '#16a34a' : v >= 3 ? '#d97706' : '#dc2626');
  charts['swr'] = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'SWR (%)', data: vals, backgroundColor: colors, borderRadius: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: textColor() }, grid: { color: gridColor() } },
        y: { ticks: { color: textColor(), callback: v => v + '%' }, grid: { color: gridColor() }, title: { display: true, text: 'SWR (%)', color: textColor() } }
      }
    }
  });
  const tbody = document.getElementById('swr-tbody');
  tbody.innerHTML = r.swrByAge.map(d => {
    const cls = d.pct >= 4 ? 'badge-green' : d.pct >= 3 ? 'badge-amber' : 'badge-red';
    const label = d.pct >= 4 ? 'Safe' : d.pct >= 3 ? 'Caution' : 'Risk';
    return `<tr><td>${d.age}</td><td>${d.pct.toFixed(2)}%</td><td>${fmtGBP(d.swr)}</td><td><span class="badge ${cls}">${label}</span></td></tr>`;
  }).join('');
}

function renderSurvivalChart(r) {
  if (!chartAvailable()) return;
  destroyChart('survival');
  const chartEl = document.getElementById('chart-survival');
  if (!chartEl) return;
  const ctx = chartEl.getContext('2d');
  charts['survival'] = new Chart(ctx, {
    type: 'line',
    data: { labels: r.ages, datasets: [{ label: 'Pot Survival Probability', data: r.survivalByAge, borderColor: '#2563eb', backgroundColor: 'rgba(37,99,235,0.1)', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: textColor() } } },
      scales: {
        x: { ticks: { color: textColor() }, grid: { color: gridColor() }, title: { display: true, text: 'Age', color: textColor() } },
        y: { ticks: { color: textColor(), callback: v => v + '%' }, grid: { color: gridColor() }, min: 0, max: 100, title: { display: true, text: 'Probability (%)', color: textColor() } }
      }
    }
  });
}

function renderRealIncomeChart(r) {
  if (!chartAvailable()) return;
  destroyChart('realincome');
  const chartEl = document.getElementById('chart-realincome');
  if (!chartEl) return;
  const ctx = chartEl.getContext('2d');
  const useToday = isTodayMoney();
  const baseInflFactor = 1 + (r.p?.inflation || 0) / 100;
  const grossData = r.realIncomeByAge.map((d, i) => useToday ? d.gross : d.gross * Math.pow(baseInflFactor, i));
  const netData = r.realIncomeByAge.map((d, i) => useToday ? d.net : d.net * Math.pow(baseInflFactor, i));

  charts['realincome'] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: r.ages,
      datasets: [
        { label: useToday ? 'Gross Income (Today\'s £)' : 'Gross Income (Nominal £)', data: grossData, borderColor: '#2563eb', backgroundColor: 'transparent', tension: 0.3, pointRadius: 0, borderWidth: 2 },
        { label: useToday ? 'Net Income (Today\'s £)' : 'Net Income (Nominal £)', data: netData, borderColor: '#16a34a', backgroundColor: 'rgba(22,163,74,0.08)', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: textColor() } } },
      scales: {
        x: { ticks: { color: textColor() }, grid: { color: gridColor() }, title: { display: true, text: 'Age', color: textColor() } },
        y: { ticks: { color: textColor(), callback: v => fmtAxisGBP(v) }, grid: { color: gridColor() }, title: { display: true, text: useToday ? 'Annual Income (Today\'s £)' : 'Annual Income (Nominal £)', color: textColor() } }
      }
    }
  });
}

function renderNetMonthlyChart(r) {
  if (!chartAvailable()) return;
  destroyChart('netmonthly');
  const chartEl = document.getElementById('chart-netmonthly');
  if (!chartEl) return;
  const ctx = chartEl.getContext('2d');

  const useToday = isTodayMoney();
  const baseInflFactor = 1 + (r.p?.inflation || 0) / 100;
  const makeSeries = (field) => r.netMonthlyByAge.map((d,i)=> useToday ? d[field] : d[field] * Math.pow(baseInflFactor, i));

  charts['netmonthly'] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: r.ages,
      datasets: [
        { label: 'Cash Pots', data: makeSeries('cash'), backgroundColor: '#0891b2', stack: 'a' },
        { label: 'Pension', data: makeSeries('pension'), backgroundColor: '#2563eb', stack: 'a' },
        { label: 'State Pension', data: makeSeries('sp'), backgroundColor: '#16a34a', stack: 'a' },
        { label: 'Other Income', data: makeSeries('other'), backgroundColor: '#d97706', stack: 'a' },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: textColor() } } },
      scales: {
        x: { stacked: true, ticks: { color: textColor(), maxTicksLimit: 12 }, grid: { color: gridColor() }, title: { display: true, text: 'Age', color: textColor() } },
        y: { stacked: true, ticks: { color: textColor(), callback: v => '£' + fmt(v) }, grid: { color: gridColor() }, title: { display: true, text: useToday ? "Net Monthly Income (Today\'s £)" : 'Net Monthly Income (Nominal £)', color: textColor() } }
      }
    }
  });
}

function renderAnnualIncomeChart(r) {
  destroyChart('annualincome');
  const ctx = document.getElementById('chart-annualincome').getContext('2d');
  const useToday = isTodayMoney();
  const dataSeries = r.annualIncomeData.map(d => useToday ? d.netReal : d.netNom);
  const label = useToday ? "Total Net /mo — Today's £ (real)" : 'Total Net /mo — Nominal (actual £)';
  charts['annualincome'] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: r.ages,
      datasets: [
        { label, data: dataSeries, borderColor: '#2563eb', backgroundColor: useToday ? 'rgba(37,99,235,0.08)' : 'transparent', fill: useToday, tension: 0.3, pointRadius: 0, borderWidth: 2 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: textColor(), font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: textColor(), maxTicksLimit: 12 }, grid: { color: gridColor() }, title: { display: true, text: 'Age', color: textColor() } },
        y: { ticks: { color: textColor(), callback: v => '£' + fmt(v) }, grid: { color: gridColor() }, title: { display: true, text: useToday ? "Net Monthly Income (Today's £)" : 'Net Monthly Income (Nominal £)', color: textColor() } }
      }
    }
  });
}

// ── Tab switching ──────────────────────────────────────────────────────────
const tabDefs = ['pot', 'annualincome', 'monthlybreakdown', 'swr', 'survival', 'realincome', 'netmonthly'];
function setActiveTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  tabDefs.forEach(t => {
    const panel = document.getElementById('tab-' + t);
    if (panel) panel.classList.toggle('hidden', t !== tab);
  });
}

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    setActiveTab(tab);
    if (lastResults) {
      if (tab === 'pot') renderPotChart(lastResults);
      else if (tab === 'swr') renderSWRChart(lastResults);
      else if (tab === 'survival') renderSurvivalChart(lastResults);
      else if (tab === 'realincome') renderRealIncomeChart(lastResults);
      else if (tab === 'netmonthly') renderNetMonthlyChart(lastResults);
      else if (tab === 'annualincome') { renderAnnualIncomeChart(lastResults); renderAnnualIncomeTable(lastResults); }
      else if (tab === 'monthlybreakdown') renderIncomeTable(lastResults);
    }
    // Sync active checkbox state to persisted value when tabs change
    setTodayMoney(todayPrices, lastResults);
  });
});

// ── Run button ─────────────────────────────────────────────────────────────
document.getElementById('run-btn').addEventListener('click', () => {
  sanitizeParams();
  const btn = document.getElementById('run-btn');
  const spinner = document.getElementById('spinner');
  btn.disabled = true; spinner.style.display = 'block';
  setTimeout(() => {
    try {
      const activeTab = document.querySelector('.tab.active')?.dataset.tab || 'pot';
      const pctileIdx = +document.getElementById('ann-pctile').value;

      const r = runSimulation();
      if (!r) {
        document.getElementById('income-tbody').innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text2);padding:20px">Simulation failed: check retirement/end ages</td></tr>';
        ['c-prob','c-guardrail-sub','c-median','c-swr','c-actual-rate','c-monthly'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.textContent = '—';
        });
        return;
      }
      r.annualIncomeData = buildAnnualIncomeData(r, pctileIdx);

      renderCards(r);
      renderIncomeTable(r);

      if (activeTab === 'pot') renderPotChart(r);
      else if (activeTab === 'swr') renderSWRChart(r);
      else if (activeTab === 'survival') renderSurvivalChart(r);
      else if (activeTab === 'realincome') renderRealIncomeChart(r);
      else if (activeTab === 'netmonthly') renderNetMonthlyChart(r);
      else if (activeTab === 'annualincome') { renderAnnualIncomeChart(r); renderAnnualIncomeTable(r); }

      setActiveTab(activeTab);
    } finally {
      btn.disabled = false; spinner.style.display = 'none';
    }
  }, 10);
});

// ── Init ───────────────────────────────────────────────────────────────────
function initApp() {
  const toggleBtn = document.getElementById('sidebar-toggle');
  const sidebar = document.getElementById('sidebar');
  toggleBtn.addEventListener('click', () => {
    const isOpen = sidebar.classList.toggle('open');
    toggleBtn.textContent = isOpen ? '✕ Close' : '⚙ Settings';
    toggleBtn.setAttribute('aria-expanded', isOpen);
  });
  document.getElementById('run-btn').addEventListener('click', () => {
    if (window.innerWidth <= 768) {
      sidebar.classList.remove('open');
      toggleBtn.textContent = '⚙ Settings';
      toggleBtn.setAttribute('aria-expanded', false);
    }
  }, true);

  document.querySelectorAll('input[name="drawdown-mode"]').forEach(radio => {
    radio.addEventListener('change', () => { updateDrawdownMode(radio.value); persistParams(); });
  });
  document.getElementById('guardrails').addEventListener('change', persistParams);
  document.getElementById('drawdown-inflation').addEventListener('change', persistParams);
  document.querySelectorAll('.today-money-toggle').forEach(cb => {
    cb.addEventListener('change', () => {
      const checked = cb.checked;
      setTodayMoney(checked, lastResults);
      persistParams();
    });
  });

  const addPotBtn = document.getElementById('add-pot-btn');
  if (addPotBtn) addPotBtn.addEventListener('click', () => { addPot(0, 0, 80); persistParams(); });

  const addIncomeBtn = document.getElementById('add-income-btn');
  if (addIncomeBtn) addIncomeBtn.addEventListener('click', () => { addIncome('Income source', 0, 'annual', 20); persistParams(); });

  const addCashPotBtn = document.getElementById('add-cash-pot-btn');
  if (addCashPotBtn) addCashPotBtn.addEventListener('click', () => { addCashPot(0, 3.5); persistParams(); });

  // Annual income percentile slider
  const annPctileSlider = document.getElementById('ann-pctile');
  const annPctileLabel  = document.getElementById('v-ann-pctile');
  annPctileSlider.addEventListener('input', () => {
    const idx = +annPctileSlider.value;
    annPctileLabel.textContent = PCT_LABELS[idx] + ' percentile';
    if (lastResults) {
      lastResults.annualIncomeData = buildAnnualIncomeData(lastResults, idx);
      renderAnnualIncomeChart(lastResults);
      renderAnnualIncomeTable(lastResults);
    }
  });

  // Try to restore persisted state; fall back to defaults
  const saved = loadPersistedParams();
  if (saved) {
    restoreParams(saved);
    // If no pots were restored, seed defaults
    if (potsData.length === 0) {
      addPot(775000, 57500, 80);
    }
    // If no incomes were restored, seed defaults
    if (incomesData.length === 0) {
      addIncome('Property income', 15600, 'annual', 22);
    }
  } else {
    // First-run defaults
    addPot(775000, 57500, 80);
    addIncome('Property income', 15600, 'annual', 22);
  }

  document.getElementById('run-btn').click();
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
