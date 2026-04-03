import { fmt, fmtGBP, fmtPct, fmtAxisGBP } from './utils.js';
import { LSA, FORMER_LTA } from './constants.js';
import { incomeTax, incomeTaxBands, calcPensionTax, calcOtherIncomesNet } from './model.js';
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

function addIncome(name, amount, frequency, inflationLinked = false) {
  const id = nextIncomeId++;
  incomesData.push({
    id,
    name: name || 'Income source',
    amount: amount !== undefined ? amount : 0,
    frequency: frequency || 'annual',
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

// ── Partner dynamic data ──────────────────────────────────────────────────
let nextPartnerPotId = 1;
let partnerPotsData = [];
let nextPartnerCashPotId = 1;
let partnerCashPotsData = [];
let nextPartnerIncomeId = 1;
let partnerIncomesData = [];

function addPartnerPot(value, annualContrib, equityPct) {
  const id = nextPartnerPotId++;
  partnerPotsData.push({
    id,
    value: (value !== undefined && value !== null) ? +value : 0,
    annualContrib: (annualContrib !== undefined && annualContrib !== null) ? +annualContrib : 0,
    equityPct: (equityPct !== undefined && equityPct !== null) ? +equityPct : 80,
  });
  renderPartnerPotsUI();
}

function removePartnerPot(id) {
  partnerPotsData = partnerPotsData.filter(p => p.id !== id);
  renderPartnerPotsUI();
  persistParams();
}

function renderPartnerPotsUI() {
  const container = document.getElementById('partner-pots-container');
  if (!container) return;
  container.innerHTML = '';
  if (partnerPotsData.length === 0) {
    container.innerHTML = '<div style="font-size:0.78rem;color:var(--text2);padding:4px 0">No pension pots added.</div>';
    return;
  }
  partnerPotsData.forEach((pot, idx) => {
    const div = document.createElement('div');
    div.className = 'pot-card';
    div.innerHTML = `
      <div class="pot-card-header">
        <span class="pot-card-title">Pot ${idx + 1}</span>
        <button class="remove-btn" data-ppartner-pot-id="${pot.id}">✕</button>
      </div>
      <div class="two-col" style="margin-bottom:8px">
        <div>
          <span class="field-label">Current value</span>
          <div class="input-group"><span class="input-prefix">£</span>
            <input class="dyn-input" type="number" min="0" step="1000" data-ppartner-pot-id="${pot.id}" data-field="value" value="${pot.value}">
          </div>
        </div>
        <div>
          <span class="field-label">Annual contribution</span>
          <div class="input-group"><span class="input-prefix">£</span>
            <input class="dyn-input" type="number" min="0" step="100" data-ppartner-pot-id="${pot.id}" data-field="annualContrib" value="${pot.annualContrib}">
          </div>
        </div>
      </div>
      <div>
        <div class="slider-label" style="margin-bottom:4px">
          <span class="slider-name">Equity / Bond</span>
          <span class="slider-val" id="v-ppartner-pot-equity-${pot.id}">${pot.equityPct}% / ${100 - pot.equityPct}%</span>
        </div>
        <input type="range" min="0" max="100" step="5" value="${pot.equityPct}" data-ppartner-pot-id="${pot.id}" data-field="equityPct" class="ppartner-pot-equity-slider">
      </div>`;
    container.appendChild(div);
  });
  container.querySelectorAll('.remove-btn[data-ppartner-pot-id]').forEach(btn => {
    btn.addEventListener('click', () => removePartnerPot(+btn.dataset.ppartnerPotId));
  });
  container.querySelectorAll('.dyn-input[data-ppartner-pot-id]').forEach(inp => {
    inp.addEventListener('input', () => {
      const pot = partnerPotsData.find(p => p.id === +inp.dataset.ppartnerPotId);
      if (pot) { pot[inp.dataset.field] = +inp.value; }
      persistParams();
    });
  });
  container.querySelectorAll('.ppartner-pot-equity-slider').forEach(slider => {
    slider.addEventListener('input', () => {
      const pot = partnerPotsData.find(p => p.id === +slider.dataset.ppartnerPotId);
      if (pot) {
        pot.equityPct = +slider.value;
        const lbl = document.getElementById('v-ppartner-pot-equity-' + pot.id);
        if (lbl) lbl.textContent = pot.equityPct + '% / ' + (100 - pot.equityPct) + '%';
      }
      persistParams();
    });
  });
}

function addPartnerCashPot(value, interestPct) {
  const id = nextPartnerCashPotId++;
  partnerCashPotsData.push({
    id,
    value: (value !== undefined && value !== null) ? +value : 0,
    interestPct: (interestPct !== undefined && interestPct !== null) ? +interestPct : 3.5,
  });
  renderPartnerCashPotsUI();
}

function removePartnerCashPot(id) {
  partnerCashPotsData = partnerCashPotsData.filter(p => p.id !== id);
  renderPartnerCashPotsUI();
  persistParams();
}

function renderPartnerCashPotsUI() {
  const container = document.getElementById('partner-cash-pots-container');
  if (!container) return;
  container.innerHTML = '';
  if (partnerCashPotsData.length === 0) {
    container.innerHTML = '<div style="font-size:0.78rem;color:var(--text2);padding:4px 0">No cash pots added.</div>';
    return;
  }
  partnerCashPotsData.forEach((pot, idx) => {
    const div = document.createElement('div');
    div.className = 'pot-card';
    div.innerHTML = `
      <div class="pot-card-header">
        <span class="pot-card-title">Cash Pot ${idx + 1}</span>
        <button class="remove-btn" data-ppartner-cash-id="${pot.id}">✕</button>
      </div>
      <div class="two-col">
        <div>
          <span class="field-label">Current value</span>
          <div class="input-group"><span class="input-prefix">£</span>
            <input class="dyn-input" type="number" min="0" step="1000" data-ppartner-cash-id="${pot.id}" data-field="value" value="${pot.value}">
          </div>
        </div>
        <div>
          <span class="field-label">Interest rate</span>
          <div class="input-group">
            <input class="dyn-input" type="number" min="0" max="20" step="0.1" data-ppartner-cash-id="${pot.id}" data-field="interestPct" value="${pot.interestPct}" style="text-align:right">
            <span class="input-suffix">%</span>
          </div>
        </div>
      </div>`;
    container.appendChild(div);
  });
  container.querySelectorAll('.remove-btn[data-ppartner-cash-id]').forEach(btn => {
    btn.addEventListener('click', () => removePartnerCashPot(+btn.dataset.ppartnerCashId));
  });
  container.querySelectorAll('.dyn-input[data-ppartner-cash-id]').forEach(inp => {
    inp.addEventListener('input', () => {
      const pot = partnerCashPotsData.find(p => p.id === +inp.dataset.ppartnerCashId);
      if (pot) { pot[inp.dataset.field] = +inp.value; }
      persistParams();
    });
  });
}

function addPartnerIncome(name, amount, frequency, inflationLinked) {
  const id = nextPartnerIncomeId++;
  partnerIncomesData.push({
    id,
    name: name || 'Income source',
    amount: amount !== undefined ? amount : 0,
    frequency: frequency || 'annual',
    inflationLinked: inflationLinked === true,
  });
  renderPartnerIncomesUI();
}

function removePartnerIncome(id) {
  partnerIncomesData = partnerIncomesData.filter(i => i.id !== id);
  renderPartnerIncomesUI();
  persistParams();
}

function renderPartnerIncomesUI() {
  const container = document.getElementById('partner-incomes-container');
  if (!container) return;
  container.innerHTML = '';
  if (partnerIncomesData.length === 0) {
    container.innerHTML = '<div style="font-size:0.78rem;color:var(--text2);padding:4px 0">No other income added.</div>';
    return;
  }
  partnerIncomesData.forEach(inc => {
    const div = document.createElement('div');
    div.className = 'income-card';
    div.innerHTML = `
      <div class="income-card-header">
        <div class="input-group" style="flex:1;margin-right:6px">
          <input class="dyn-input" type="text" placeholder="Name" data-pinc-id="${inc.id}" data-field="name" value="${inc.name.replace(/"/g,'&quot;')}" style="font-weight:600">
        </div>
        <button class="remove-btn" data-pinc-id="${inc.id}">✕</button>
      </div>
      <div class="two-col">
        <div>
          <span class="field-label">Amount</span>
          <div class="input-group"><span class="input-prefix">£</span>
            <input class="dyn-input" type="number" min="0" step="100" data-pinc-id="${inc.id}" data-field="amount" value="${inc.amount}">
          </div>
        </div>
        <div>
          <span class="field-label">Frequency</span>
          <select class="dyn-select" data-pinc-id="${inc.id}" data-field="frequency">
            <option value="annual" ${inc.frequency === 'annual' ? 'selected' : ''}>Annual</option>
            <option value="monthly" ${inc.frequency === 'monthly' ? 'selected' : ''}>Monthly</option>
          </select>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;margin-top:6px">
        <input type="checkbox" data-pinc-id="${inc.id}" data-field="inflationLinked" ${inc.inflationLinked ? 'checked' : ''} style="cursor:pointer;width:14px;height:14px">
        <span style="font-size:0.78rem;color:var(--text2)">Increases with inflation</span>
      </div>`;
    container.appendChild(div);
  });
  container.querySelectorAll('.remove-btn[data-pinc-id]').forEach(btn => {
    btn.addEventListener('click', () => removePartnerIncome(+btn.dataset.pincId));
  });
  container.querySelectorAll('[data-pinc-id]').forEach(el => {
    const evName = (el.tagName === 'SELECT' || el.type === 'checkbox') ? 'change' : 'input';
    el.addEventListener(evName, () => {
      const inc = partnerIncomesData.find(i => i.id === +el.dataset.pincId);
      if (inc) {
        if (el.dataset.field === 'inflationLinked') inc[el.dataset.field] = el.checked;
        else if (el.dataset.field === 'name' || el.dataset.field === 'frequency') inc[el.dataset.field] = el.value;
        else inc[el.dataset.field] = +el.value;
      }
      persistParams();
    });
  });
}

// ── Slider wiring ──────────────────────────────────────────────────────────
function getPartnerEnabled() {
  return document.getElementById('partner-enabled')?.checked || false;
}

function getPartnerParams() {
  if (!getPartnerEnabled()) return null;
  return {
    currentAge: +document.getElementById('partner-age').value,
    retirementAge: +document.getElementById('partner-retirement-age').value,
    spAge: +document.getElementById('partner-sp-age').value,
    sp: +document.getElementById('partner-sp').value,
    pots: partnerPotsData.map(p => Object.assign({}, p)),
    cashPots: partnerCashPotsData.map(p => Object.assign({}, p)),
    incomes: partnerIncomesData.map(i => Object.assign({}, i)),
  };
}

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
    returnPct: +document.getElementById('return-pct').value,
    runs: +document.getElementById('runs').value,
    guardrails: document.getElementById('guardrails').checked,
    drawdownMode: document.querySelector('input[name="drawdown-mode"]:checked')?.value || 'amount',
    drawdownPct: +document.getElementById('drawdown-pct').value,
    drawdownInflation: document.getElementById('drawdown-inflation').checked,
    pots: potsData.map(p => Object.assign({}, p)),
    incomes: incomesData.map(i => Object.assign({}, i)),
    cashPots: cashPotsData.map(p => Object.assign({}, p)),
    partner: getPartnerParams(),
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

  if (retirementAge < currentAge) {
    retirementAge = currentAge;
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
    if (tab === 'pot') { renderPotChart(r); renderIncomeTable(r); }
    else if (tab === 'swr') renderSWRChart(r);
    else if (tab === 'taxbreakdown') renderTaxBreakdown(r);
    else if (tab === 'realincome') renderRealIncomeChart(r);
    else if (tab === 'netmonthly') renderNetMonthlyChart(r);
    else if (tab === 'annualincome') { renderAnnualIncomeChart(r); renderAnnualIncomeTable(r); }
    else if (tab === 'montecarlo') { renderMonteCarloChart(r); renderMonteCarloTable(r, +document.getElementById('mc-pctile').value); }
  }
}

const sliders = [
  ['current-age', v => v, ''], ['retirement-age', v => v, ''],
  ['end-age', v => v, ''], ['sp-age', v => v, ''],
  ['reduction-age', v => v, ''], ['reduction-pct', v => fmtPct(v), ''],
  ['drawdown', v => fmtGBP(v), ''], ['drawdown-pct', v => fmtPct(+v, 2), ''],
  ['sp', v => fmtGBP(v), ''], ['inflation', v => fmtPct(v), ''],
  ['return-pct', v => fmtPct(+v, 1), ''],
  ['runs', v => fmt(v), ''],
];
const partnerSliders = [
  ['partner-age', v => v],
  ['partner-retirement-age', v => v],
  ['partner-sp-age', v => v],
  ['partner-sp', v => fmtGBP(v)],
];
sliders.forEach(([id, formatter]) => {
  const el = document.getElementById(id);
  const label = document.getElementById('v-' + id);
  el.addEventListener('input', () => {
    label.textContent = formatter(+el.value);
    // Clear preset active state when slider is moved manually
    document.querySelectorAll(`.preset-btn[data-target="${id}"]`).forEach(b => {
      b.classList.toggle('active', b.dataset.value === el.value);
    });
    persistParams();
  });
});
partnerSliders.forEach(([id, formatter]) => {
  const el = document.getElementById(id);
  const label = document.getElementById('v-' + id);
  if (el && label) el.addEventListener('input', () => { label.textContent = formatter(+el.value); persistParams(); });
});

// Keep retirement-age min in sync with current-age, and end-age min with retirement-age
document.getElementById('current-age').addEventListener('input', () => {
  const currentAge = +document.getElementById('current-age').value;
  const retireEl = document.getElementById('retirement-age');
  retireEl.min = currentAge;
  if (+retireEl.value < currentAge) {
    retireEl.value = currentAge;
    document.getElementById('v-retirement-age').textContent = currentAge;
  }
});
document.getElementById('retirement-age').addEventListener('input', () => {
  const retirementAge = +document.getElementById('retirement-age').value;
  const endEl = document.getElementById('end-age');
  endEl.min = retirementAge + 1;
  if (+endEl.value <= retirementAge) {
    endEl.value = retirementAge + 1;
    document.getElementById('v-end-age').textContent = retirementAge + 1;
  }
});

// ── Persistence ────────────────────────────────────────────────────────────
const LS_KEY = 'pension-forecast-v7';
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
  obj['partner-enabled'] = getPartnerEnabled() ? '1' : '0';
  partnerSliders.forEach(([id]) => { const el = document.getElementById(id); if (el) obj[id] = el.value; });
  obj['partner-pots'] = JSON.stringify(partnerPotsData);
  obj['partner-cashPots'] = JSON.stringify(partnerCashPotsData);
  obj['partner-incomes'] = JSON.stringify(partnerIncomesData);
  // Save full state to localStorage AND sessionStorage as backups.
  // sessionStorage survives same-tab hard refreshes (even when Safari strips the hash).
  try { const s = JSON.stringify(obj); localStorage.setItem(LS_KEY, s); sessionStorage.setItem(LS_KEY, s); } catch(e) {}
  // Encode complete state as a single base64 blob in the URL hash so the full
  // settings survive hard refreshes and cross-deployment URL sharing.
  try {
    const blob = btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
    history.replaceState(null, '', '#v=' + blob);
  } catch(e) {}
}

function loadPersistedParams() {
  // Primary: try the base64 blob format (#v=<blob>)
  if (location.hash.length > 1) {
    try {
      const params = new URLSearchParams(location.hash.slice(1));
      const blob = params.get('v');
      if (blob) {
        const obj = JSON.parse(decodeURIComponent(escape(atob(blob))));
        if (obj && typeof obj === 'object' && Object.keys(obj).length > 0) return obj;
      }
    } catch(e) {}
    // Fallback: old-format hash (#key=value&...) — upgrade by supplementing from localStorage
    try {
      const obj = Object.fromEntries(new URLSearchParams(location.hash.slice(1)));
      if (Object.keys(obj).length > 0) {
        try {
          const raw = localStorage.getItem(LS_KEY);
          if (raw) {
            const ls = JSON.parse(raw);
            ['pots','incomes','cashPots','partner-pots','partner-cashPots','partner-incomes'].forEach(k => {
              if (ls[k] && !obj[k]) obj[k] = ls[k];
            });
          }
        } catch(e) {}
        return obj;
      }
    } catch(e) {}
  }
  // sessionStorage: survives same-tab hard refresh in Safari even when hash is stripped
  try { const raw = sessionStorage.getItem(LS_KEY); if (raw) return JSON.parse(raw); } catch(e) {}
  // Final fallback: localStorage (same domain only)
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
          incomesData.push({ id, name: inc.name || 'Income source', amount: inc.amount || 0, frequency: inc.frequency || 'annual', inflationLinked: inc.inflationLinked === true });
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
  // Restore partner
  if (obj['partner-enabled'] !== undefined) {
    const enabled = obj['partner-enabled'] !== '0';
    const cb = document.getElementById('partner-enabled');
    if (cb) {
      cb.checked = enabled;
      document.getElementById('partner-section').classList.toggle('hidden', !enabled);
    }
  }
  partnerSliders.forEach(([id, formatter]) => {
    if (obj[id] === undefined) return;
    const el = document.getElementById(id);
    const label = document.getElementById('v-' + id);
    if (el) { el.value = obj[id]; if (label) label.textContent = formatter(+obj[id]); }
  });
  if (obj['partner-pots']) {
    try {
      const saved = JSON.parse(obj['partner-pots']);
      if (Array.isArray(saved) && saved.length > 0) {
        partnerPotsData = [];
        saved.forEach(p => {
          const id = nextPartnerPotId++;
          partnerPotsData.push({ id, value: +p.value || 0, annualContrib: +p.annualContrib || 0, equityPct: p.equityPct !== undefined ? +p.equityPct : 80 });
        });
        renderPartnerPotsUI();
      }
    } catch(e) {}
  }
  if (obj['partner-cashPots']) {
    try {
      const saved = JSON.parse(obj['partner-cashPots']);
      if (Array.isArray(saved)) {
        partnerCashPotsData = [];
        saved.forEach(p => {
          const id = nextPartnerCashPotId++;
          partnerCashPotsData.push({ id, value: +p.value || 0, interestPct: p.interestPct !== undefined ? +p.interestPct : 3.5 });
        });
        renderPartnerCashPotsUI();
      }
    } catch(e) {}
  }
  if (obj['partner-incomes']) {
    try {
      const saved = JSON.parse(obj['partner-incomes']);
      if (Array.isArray(saved)) {
        partnerIncomesData = [];
        saved.forEach(inc => {
          const id = nextPartnerIncomeId++;
          partnerIncomesData.push({ id, name: inc.name || 'Income source', amount: inc.amount || 0, frequency: inc.frequency || 'annual', inflationLinked: inc.inflationLinked === true });
        });
        renderPartnerIncomesUI();
      }
    } catch(e) {}
  }
}

// ── Drawdown mode UI toggle ────────────────────────────────────────────────
function updateDrawdownMode(mode) {
  document.getElementById('drawdown-amount-row').classList.toggle('hidden', mode !== 'amount');
  document.getElementById('drawdown-pct-row').classList.toggle('hidden', mode !== 'pct');
}

const PCT_LABELS = ['5th', '25th', '50th (Median)', '75th', '95th'];
const MC_PCT_LABELS = ['1st', '5th', '25th', '50th (Median)', '75th', '95th'];
const HIST_YEAR_EVENTS = {
  1914: 'WWI', 1915: 'WWI', 1916: 'WWI', 1917: 'WWI', 1918: 'WWI',
  1929: 'Wall St. Crash', 1930: 'Great Depression', 1931: 'Great Depression', 1932: 'Great Depression',
  1937: 'Recession relapse',
  1940: 'WWII', 1941: 'WWII', 1942: 'WWII', 1943: 'WWII', 1944: 'WWII', 1945: 'WWII ends',
  1973: 'Oil Crisis', 1974: 'Oil Crisis',
  1987: 'Black Monday',
  1990: 'Recession',
  2000: 'Dot-com Crash', 2001: 'Dot-com / 9/11', 2002: 'Dot-com Crash',
  2008: 'Financial Crisis',
  2020: 'Covid Crash',
  1933: 'New Deal Rally', 1954: 'Post-war Boom',
  1975: 'Recovery Rally', 1982: 'Bull Market begins',
  1995: 'Tech Boom', 1997: 'Tech Boom', 1999: 'Dot-com Peak',
};

function buildAnnualIncomeData(r) {
  const p = r.p;
  const baseInflFactor = 1 + p.inflation / 100;
  const yearsToRetirement = Math.max(0, p.retirementAge - p.currentAge);
  const currentYear = new Date().getFullYear();
  const startPensionPot = r.startPensionPot || r.startPot;
  const partnerPotBalance = 0;
  const partnerCashBalance = 0;

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
    const partner = p.partner;
    const partnerAge = partner ? partner.currentAge + (age - p.currentAge) : null;
    const hasPartnerSP = !!(partner && partnerAge >= partner.spAge);
    const partnerSpInflated = hasPartnerSP ? partner.sp * ci : 0;

    for (let ci2 = 0; ci2 < (p.cashPots || []).length; ci2++) {
      cashBals[ci2] *= (1 + p.cashPots[ci2].interestPct / 100);
    }

    const otherNet = calcOtherIncomesNet(p.incomes, ciFromNow);
    const partnerRetiredAID = !!(partner && partnerAge >= partner.retirementAge);
    const partnerOtherAID = (partner?.incomes?.length && partnerRetiredAID)
      ? calcOtherIncomesNet(partner.incomes, ciFromNow) : { grossTotal: 0, taxTotal: 0, netTotal: 0 };
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
    const partnerTFracYear = (partner && actualParDraw > 0)
      ? Math.min(0.25, Math.max(0, LSA - cumulPartnerTaxFree) / actualParDraw)
      : 0.25;
    const taxFreeFracYear = potWithdrawNominal > 0
      ? (actualPriDraw * primaryTFracYear + actualParDraw * partnerTFracYear) / potWithdrawNominal
      : 0.25;
    const tc = calcPensionTax(potWithdrawNominal, spInflated, hasStatePension, taxFreeFracYear, otherNet.grossTotal);
    cumulPrimaryTaxFree = Math.min(LSA, cumulPrimaryTaxFree + actualPriDraw * primaryTFracYear);
    if (partner) cumulPartnerTaxFree = Math.min(LSA, cumulPartnerTaxFree + actualParDraw * partnerTFracYear);

    const totalNetNominal = cashContrib + tc.pensionNet + (hasStatePension ? tc.spNet : 0) + tc.otherNet + partnerSpInflated + partnerOtherAID.netTotal;

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
      // SP: show gross as headline so both SP columns are directly comparable;
      // tax on primary SP is a sub-line; the correct after-tax total is in Total Net
      spNom: spInflated / 12,
      spReal: (spInflated * todayDeflator) / 12,
      otherNom: tc.otherNet / 12,
      netNom: totalNetNominal / 12,
      pensionReal: (tc.pensionNet * todayDeflator) / 12,
      otherReal: (tc.otherNet * todayDeflator) / 12,
      netReal: (totalNetNominal * todayDeflator) / 12,
      // Partner SP
      partnerSpNom: partnerSpInflated / 12,
      partnerSpReal: (partnerSpInflated * todayDeflator) / 12,
      partnerSpGrossNom: partnerSpInflated / 12,
      partnerSpGrossReal: (partnerSpInflated * todayDeflator) / 12,
      // Gross/tax breakdown for income column sub-lines
      pensionGrossNom: potWithdrawNominal / 12,
      pensionTaxNom: tc.pensionTax / 12,
      pensionGrossReal: (potWithdrawNominal * todayDeflator) / 12,
      pensionTaxReal: (tc.pensionTax * todayDeflator) / 12,
      spGrossNom: spInflated / 12,
      spTaxNom: hasStatePension ? tc.spTax / 12 : 0,
      spGrossReal: (spInflated * todayDeflator) / 12,
      spTaxReal: hasStatePension ? (tc.spTax * todayDeflator) / 12 : 0,
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
      // Partner pot/cash balance informational columns
      partnerPotBalNom: partnerPotBalance,
      partnerPotBalReal: partnerPotBalance * todayDeflator,
      partnerCashBalNom: partnerCashBalance,
      partnerCashBalReal: partnerCashBalance * todayDeflator,
      // Partner other income breakdown (net/gross/tax)
      partnerOtherNom: partnerOtherAID.netTotal / 12,
      partnerOtherReal: (partnerOtherAID.netTotal * todayDeflator) / 12,
      partnerOtherGrossNom: partnerOtherAID.grossTotal / 12,
      partnerOtherGrossReal: (partnerOtherAID.grossTotal * todayDeflator) / 12,
      partnerOtherTaxNom: partnerOtherAID.taxTotal / 12,
      partnerOtherTaxReal: (partnerOtherAID.taxTotal * todayDeflator) / 12,
      guardrailActive,
      isSpStart: age === p.spAge,
      isPartnerSpStart: !!(partner && partnerAge === partner.spAge),
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
  const isJoint = !!r.p.partner;
  const probEl = document.getElementById('c-prob');
  probEl.textContent = r.prob.toFixed(1) + '%';
  probEl.className = 'card-value ' + (r.prob >= 90 ? 'green' : r.prob >= 70 ? 'amber' : 'red');
  const probLabel = document.getElementById('c-prob-label');
  if (probLabel) probLabel.textContent = isJoint ? 'Joint Probability of Success' : 'Probability of Success';

  document.getElementById('c-guardrail-sub').textContent = r.p.guardrails
    ? `${isJoint ? 'joint plan' : 'pot'} survives · guardrail in ${r.guardrailPct.toFixed(0)}% of runs`
    : `${isJoint ? 'joint plan' : 'pot'} survives · guardrails off`;

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
      <span style="display:block;font-size:0.72rem;color:var(--text2)">Gross monthly: <strong style="color:var(--text)">${fmtGBP(r.grossMonthly, 0)}</strong></span>
      <span style="display:block;font-size:0.72rem;color:var(--text2)">Net annual: <strong style="color:var(--text)">${fmtGBP(r.netAnnual, 0)}</strong></span>
      <span style="display:block;font-size:0.72rem;color:var(--text2)">Gross annual: <strong style="color:var(--text)">${fmtGBP(r.grossAnnual, 0)}</strong></span>`;
  }

  const lsaAlert = document.getElementById('lsa-alert');
  lsaAlert.classList.toggle('hidden', r.startPot <= FORMER_LTA);
}

function cloneParams(p) {
  if (typeof structuredClone === 'function') return structuredClone(p);
  return JSON.parse(JSON.stringify(p));
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function renderExplainability(explain, r) {
  const narrativeEl = document.getElementById('explain-narrative');
  const driversEl = document.getElementById('explain-drivers');
  if (!narrativeEl || !driversEl) return;

  if (!explain || !r) {
    narrativeEl.textContent = 'Run the model to see what is helping or hurting your plan the most.';
    driversEl.innerHTML = '<li>We will show the top 3 things to tweak, and how much each may change success odds.</li>';
    return;
  }

  const best = explain.drivers[0];
  const direction = best.deltaProb >= 0 ? 'could improve' : 'could lower';
  const byPp = Math.abs(best.deltaProb).toFixed(1);
  narrativeEl.textContent = `Biggest lever right now: ${best.label}. This ${direction} your success chance by about ${byPp} points in our estimate.`;

  driversEl.innerHTML = explain.drivers.map(d => {
    const sign = d.deltaProb >= 0 ? '+' : '-';
    const cls = d.deltaProb >= 0 ? 'green' : 'red';
    const effect = d.deltaProb >= 0 ? 'better' : 'worse';
    return `<li>If you try <strong>${d.label}</strong>, success is estimated at <strong>${(r.prob + d.deltaProb).toFixed(1)}%</strong> (<span class="${cls}">${sign}${Math.abs(d.deltaProb).toFixed(1)} points</span>, ${effect} than current ${r.prob.toFixed(1)}%).</li>`;
  }).join('');
}

function buildExplainability(baseParams, baseline) {
  const explainRuns = Math.max(250, Math.min(600, Math.floor((baseParams.runs || 1000) * 0.35)));

  const scenarios = [
    {
      label: baseParams.drawdownMode === 'pct' ? 'reduce drawdown rate by 0.5%' : 'reduce annual drawdown by 10%',
      mutate(p) {
        if (p.drawdownMode === 'pct') p.drawdownPct = clamp((p.drawdownPct || 0) - 0.5, 1, 12);
        else p.drawdown = Math.max(0, Math.round((p.drawdown || 0) * 0.90));
      }
    },
    {
      label: 'retire 1 year later',
      mutate(p) {
        p.retirementAge = clamp((p.retirementAge || 0) + 1, p.currentAge, p.endAge - 1);
      }
    },
    {
      label: 'assume inflation is 1% higher',
      mutate(p) {
        p.inflation = clamp((p.inflation || 0) + 1.0, 0.5, 10);
      }
    },
    {
      label: 'hold 10% more equities in pension pots',
      mutate(p) {
        (p.pots || []).forEach(pt => { pt.equityPct = clamp((pt.equityPct || 0) + 10, 0, 100); });
        (p.partner?.pots || []).forEach(pt => { pt.equityPct = clamp((pt.equityPct || 0) + 10, 0, 100); });
      }
    }
  ];

  const drivers = [];
  for (const sc of scenarios) {
    const p2 = cloneParams(baseParams);
    p2.runs = explainRuns;
    sc.mutate(p2);
    const r2 = runSimulationImpl(p2);
    if (!r2) continue;
    drivers.push({
      label: sc.label,
      deltaProb: r2.prob - baseline.prob,
    });
  }

  drivers.sort((a, b) => Math.abs(b.deltaProb) - Math.abs(a.deltaProb));
  return { drivers: drivers.slice(0, 3) };
}

// ── Render Income Table ────────────────────────────────────────────────────
function renderIncomeTable(r) {
  const p = r.p;
  const baseInfl = 1 + p.inflation / 100;
  const yearsToRetirement = Math.max(0, p.retirementAge - p.currentAge);
  const isToday = isTodayMoney();

  // The three snapshot year-indices (years from retirement)
  const spYears = Math.max(0, p.spAge - p.retirementAge);
  const redYears = Math.max(0, p.reductionAge - p.retirementAge);

  // ciFromNow(y) = total inflation from today to retirement+y years.
  // All monetary inputs (drawdown, other income amounts) are in today's money,
  // so this is the correct factor to inflate them to nominal at each snapshot.
  // p.sp is pre-inflated to retirement by runSimulation, so it uses the same
  // ci (from retirement) that buildAnnualIncomeData uses.
  function ciFromNow(y) { return Math.pow(baseInfl, yearsToRetirement + y); }
  // todayDeflator converts nominal-at-snapshot back to today's money
  function todayDef(y)  { return isToday ? Math.pow(1 / baseInfl, yearsToRetirement + y) : 1; }

  // Pull pre-computed snapshot data from annualIncomeData (same logic as charts/annual table)
  const annData = r.annualIncomeData || [];
  const snap = [0, spYears, redYears].map(y => annData[y] ?? null);
  // snap[col] has: pensionGrossNom, pensionTaxNom, pensionNom (net/12),
  //   spGrossNom, spTaxNom, cashNom (net/12), partnerSpNom,
  //   otherGrossNom, otherTaxNom, otherNom (net/12),
  //   netGrossNom, netTaxNom, netNom (all /12)
  // We need annual figures so multiply monthly (*12) then apply todayDef

  // Helper: extract annual (not monthly) gross/tax/net from a snap row, scaled to display money
  function snapAnn(row, grossKey, taxKey, netKey, y) {
    if (!row) return { g: 0, t: 0, n: 0 };
    const d = todayDef(y);
    return {
      g: row[grossKey] * 12 * d,
      t: row[taxKey]  * 12 * d,
      n: row[netKey]  * 12 * d,
    };
  }

  // Cell renderer: values are already in display money
  function cell(g, t, n) {
    return `${fmtGBP(g/12)} / <span style="color:var(--red)">${fmtGBP(t/12)}</span> / <strong>${fmtGBP(n/12)}</strong>`;
  }
  function row3(label, s1, s2, s3, note) {
    return `<tr><td>${label}</td><td>${cell(s1.g,s1.t,s1.n)}</td><td>${cell(s2.g,s2.t,s2.n)}</td><td>${cell(s3.g,s3.t,s3.n)}</td><td>${note}</td></tr>`;
  }

  // ── Per-source other income rows ───────────────────────────────────────
  // Use ciFromNow for both inflation and the tax-ratio denominator so both are on the same basis.
  function incomeRowData(incomes, activeFlags, snapRows, snapYears) {
    // aggregate gross per column using ciFromNow (same basis as buildAnnualIncomeData)
    const aggGross = snapYears.map((y, col) => {
      if (!activeFlags[col]) return 0;
      return incomes.reduce((s, inc) => {
        const ann = inc.frequency === 'monthly' ? inc.amount * 12 : inc.amount;
        return s + ann * (inc.inflationLinked ? ciFromNow(y) : 1);
      }, 0);
    });
    // per-income-source rows
    return incomes.map(inc => {
      const ann = inc.frequency === 'monthly' ? inc.amount * 12 : inc.amount;
      return snapYears.map((y, col) => {
        if (!activeFlags[col]) return { g: 0, t: 0, n: 0 };
        const snapRow = snapRows[col];
        const totalOtherTaxAnn = snapRow ? snapRow.otherTaxNom * 12 : 0;
        const d = todayDef(y);
        const g = ann * (inc.inflationLinked ? ciFromNow(y) : 1);
        // allocate tax proportionally from the aggregate tax computed by buildAnnualIncomeData
        const t = aggGross[col] > 0 ? totalOtherTaxAnn * (g / aggGross[col]) : 0;
        return { g: g * d, t: t * d, n: (g - t) * d };
      });
    });
  }

  // Partner ages at each snapshot
  const partnerAgeAt = [p.retirementAge, p.spAge, p.reductionAge].map(age =>
    p.partner ? p.partner.currentAge + (age - p.currentAge) : null
  );
  const pIncActive = partnerAgeAt.map(pa => !!(p.partner && pa >= p.partner.retirementAge));

  // ── Build display values from annualIncomeData snapshots ───────────────
  const cols = [0, spYears, redYears];

  // Cash pots
  const cashS = cols.map((y, col) => {
    const snapRow = snap[col];
    if (!snapRow) return { g: 0, t: 0, n: 0 };
    const d = todayDef(y);
    const v = snapRow.cashNom * 12 * d;
    return { g: v, t: 0, n: v };
  });

  // Pension from pot
  const pensionS = cols.map((y, col) => snapAnn(snap[col], 'pensionGrossNom', 'pensionTaxNom', 'pensionNom', y));

  // State pension — spNom is gross (same field as spGrossNom); net = gross - tax
  // col 0: if retirement < spAge, spGrossNom will be 0 from buildAnnualIncomeData already
  const spS = cols.map((y, col) => {
    const snapRow = snap[col];
    if (!snapRow) return { g: 0, t: 0, n: 0 };
    const d = todayDef(y);
    const g = snapRow.spGrossNom * 12 * d;
    const t = snapRow.spTaxNom  * 12 * d;
    return { g, t, n: g - t };
  });

  // Partner state pension
  const pSpS = cols.map((y, col) => {
    const snapRow = snap[col];
    if (!snapRow || !p.partner) return { g: 0, t: 0, n: 0 };
    const d = todayDef(y);
    const v = snapRow.partnerSpNom * 12 * d;
    return { g: v, t: 0, n: v };
  });

  // Per-source partner income rows
  // Partner other income has no separate tax entry in annData (calcOtherIncomesNet returns taxTotal:0)
  const pIncomeRows = p.partner?.incomes?.length
    ? incomeRowData(p.partner.incomes, pIncActive, snap.map(() => null), cols)
    : [];

  // Per-source primary other income rows
  const otherRows = p.incomes.length
    ? incomeRowData(p.incomes, [true, true, true], snap, cols)
    : [];

  // ── Total row ──────────────────────────────────────────────────────────
  const totS = cols.map((y, col) => {
    const snapRow = snap[col];
    if (!snapRow) return { g: 0, t: 0, n: 0 };
    const d = todayDef(y);
    return {
      g: snapRow.netGrossNom * 12 * d,
      t: snapRow.netTaxNom  * 12 * d,
      n: snapRow.netNom     * 12 * d,
    };
  });

  // ── Badges ─────────────────────────────────────────────────────────────
  const tfFrac1 = snap[0]?.primaryTaxFreeFracAnn ?? r.taxFreeFrac;
  const lsaBadge = tfFrac1 < 0.25
    ? `<span class="badge badge-amber">${(tfFrac1 * 100).toFixed(1)}% tax-free (LSA capped)</span>`
    : `<span class="badge badge-green">25% tax-free (within LSA)</span>`;
  const ltaBadge = (r.startPensionPot || r.startPot) > FORMER_LTA
    ? ` <span class="badge badge-warning">⚠ Former LTA exceeded</span>`
    : '';

  document.getElementById('th-after-reduction').innerHTML =
    `At Reduction (age ${p.reductionAge})<br><small style="font-weight:400">Gross / Tax / Net</small>`;

  // ── Assemble rows ───────────────────────────────────────────────────────
  let rows = '';

  if (p.cashPots?.length > 0) {
    const totalCashStart = (r.startCashPotVals || []).reduce((s, v) => s + v, 0);
    rows += row3('Cash pots (drawn first)', cashS[0], cashS[1], cashS[2],
      `Tax-free · ${fmtGBP(totalCashStart)} at retirement`);
  }

  rows += row3('Pension (from pot)', pensionS[0], pensionS[1], pensionS[2], lsaBadge + ltaBadge);
  rows += row3('State pension', spS[0], spS[1], spS[2], `From age ${p.spAge}`);

  if (p.partner) {
    rows += row3('Partner state pension', pSpS[0], pSpS[1], pSpS[2], `From age ${p.partner.spAge}`);
    pIncomeRows.forEach((colData, idx) => {
      const inc = p.partner.incomes[idx];
      const fromAge = p.partner.retirementAge > p.retirementAge ? ` · from age ${p.partner.retirementAge}` : '';
      rows += row3(inc.name, colData[0], colData[1], colData[2],
        `Partner · ${inc.inflationLinked ? 'CPI-linked' : 'Fixed'}${fromAge}`);
    });
  }

  otherRows.forEach((colData, idx) => {
    const inc = p.incomes[idx];
    rows += row3(inc.name, colData[0], colData[1], colData[2],
      inc.inflationLinked ? 'CPI-linked' : 'Fixed');
  });

  rows += `<tr>
    <td><strong>Total</strong></td>
    <td>${cell(totS[0].g, totS[0].t, totS[0].n)}</td>
    <td>${cell(totS[1].g, totS[1].t, totS[1].n)}</td>
    <td>${cell(totS[2].g, totS[2].t, totS[2].n)}</td>
    <td></td>
  </tr>`;

  document.getElementById('income-tbody').innerHTML = rows;
}

// ── Render Annual Income Table ─────────────────────────────────────────────
function renderAnnualIncomeTable(r) {
  const tbody = document.getElementById('annual-income-tbody');
  const isToday = isTodayMoney();
  const hasPartner = !!r.p?.partner;

  // Show/hide partner columns based on hasPartner
  ['ann-th-partner-sp', 'ann-th-partner-other'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = hasPartner ? '' : 'none';
  });

  // Single-value cell — picks nominal or today's money based on toggle
  function cell(nom, real) {
    const v = isToday ? real : nom;
    return `<td style="text-align:right">${fmtGBP(v)}</td>`;
  }

  // Income cell — net headline with gross and tax as sub-lines
  // hidden=true keeps the <td> in the DOM (preserving column count) but hides it visually
  function incomeCell(netNom, netReal, grossNom, grossReal, taxNom, taxReal, hidden = false) {
    const net   = isToday ? netReal   : netNom;
    const gross = isToday ? grossReal : grossNom;
    const tax   = isToday ? taxReal   : taxNom;
    const style = hidden ? 'text-align:right;display:none' : 'text-align:right';
    return `<td style="${style}">${fmtGBP(net)}<span class="ann-sub">Gross: ${fmtGBP(gross)}</span><span class="ann-sub ann-tax">Tax: ${fmtGBP(tax)}</span></td>`;
  }

  // Growth cell — coloured red for negative values
  function growthCell(nom, real) {
    const v = isToday ? real : nom;
    const str = v >= 0 ? fmtGBP(v) : `<span style="color:var(--red)">${fmtGBP(v)}</span>`;
    return `<td style="text-align:right">${str}</td>`;
  }

  tbody.innerHTML = r.annualIncomeData.map(d => {
    let cls = '';
    if (d.guardrailActive) cls = 'guardrail-row';
    else if (d.isSpStart) cls = 'sp-start-row';
    else if (d.isPartnerSpStart) cls = 'partner-sp-start-row';
    const ageDisplay = hasPartner
      ? `${d.age}<span style="color:var(--text2)">/${d.partnerAge}</span>`
      : `${d.age}`;
    const ageLabel = d.age === r.p.retirementAge && r.p.retirementAge > r.p.currentAge
      ? `${ageDisplay}<br><span style="font-size:0.72rem;color:var(--text2)">${d.calYear} · pre-ret. growth →</span>`
      : `${ageDisplay}<br><span style="font-size:0.72rem;color:var(--text2)">${d.calYear}</span>`;
    return `<tr class="${cls}">
      <td>${ageLabel}</td>
      ${cell(d.cashNom, d.cashReal)}
      ${incomeCell(d.pensionNom, d.pensionReal, d.pensionGrossNom, d.pensionGrossReal, d.pensionTaxNom, d.pensionTaxReal)}
      ${incomeCell(d.spNom, d.spReal, d.spGrossNom, d.spGrossReal, d.spTaxNom, d.spTaxReal)}
      ${incomeCell(d.partnerSpNom || 0, d.partnerSpReal || 0, d.partnerSpGrossNom || 0, d.partnerSpGrossReal || 0, 0, 0, !hasPartner)}
      ${incomeCell(d.otherNom, d.otherReal, d.otherGrossNom, d.otherGrossReal, d.otherTaxNom, d.otherTaxReal)}
      ${incomeCell(d.partnerOtherNom || 0, d.partnerOtherReal || 0, d.partnerOtherGrossNom || 0, d.partnerOtherGrossReal || 0, d.partnerOtherTaxNom || 0, d.partnerOtherTaxReal || 0, !hasPartner)}
      ${incomeCell(d.netNom, d.netReal, d.netGrossNom, d.netGrossReal, d.netTaxNom, d.netTaxReal)}
      ${incomeCell(d.netNom * 12, d.netReal * 12, d.netGrossNom * 12, d.netGrossReal * 12, d.netTaxNom * 12, d.netTaxReal * 12)}
      ${cell(d.cashWithdrawalNom, d.cashWithdrawalReal)}
      ${cell(d.pensionWithdrawalNom, d.pensionWithdrawalReal)}
      ${growthCell(d.growthNom, d.growthReal)}
      ${growthCell(d.netPotChangeNom, d.netPotChangeReal)}
      ${cell(d.potBalNom, d.potBalReal)}
    </tr>`;
  }).join('');
}

// ── Chart helpers ──────────────────────────────────────────────────────────
function isDark() { return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; }
function gridColor() { return isDark() ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'; }
function textColor() { return isDark() ? '#9ca3af' : '#6b7280'; }
function destroyChart(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }

// ── Pot Chart (Deterministic) ─────────────────────────────────────────────
function renderPotChart(r) {
  if (!chartAvailable()) return;
  destroyChart('pot');
  const chartEl = document.getElementById('chart-pot');
  if (!chartEl) return;
  const ctx = chartEl.getContext('2d');
  const useToday = isTodayMoney();
  const baseInflFactor = 1 + (r.p?.inflation || 0) / 100;
  const yearsToRetirement = Math.max(0, r.p.retirementAge - r.p.currentAge);
  const deflator = i => Math.pow(1 / baseInflFactor, yearsToRetirement + i);
  const spAgeIdx = r.ages.indexOf(r.p.spAge);
  const returnPct = r.returnPct ?? 5;

  const detVals = Array.from(r.detPotByYear || []).map((v, i) => useToday ? v * deflator(i) : v);

  const titleEl = document.getElementById('pot-chart-title');
  if (titleEl) titleEl.textContent = `Pot Balance — Deterministic Projection (${returnPct}% return)`;

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
        { label: `${returnPct}% return`, data: detVals, borderColor: 'rgba(37,99,235,1)', backgroundColor: 'rgba(37,99,235,0.08)', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2 },
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

// ── Pot Chart (Monte Carlo Fan) ───────────────────────────────────────────
function renderMonteCarloChart(r) {
  if (!chartAvailable()) return;
  destroyChart('montecarlo');
  const chartEl = document.getElementById('chart-montecarlo');
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

  charts['montecarlo'] = new Chart(ctx, {
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

function renderMonteCarloTable(r, pctileIdx = 3) {
  const tbody = document.getElementById('mc-year-tbody');
  if (!tbody) return;
  const paths = r.mcRepPaths;
  if (!paths || !paths[pctileIdx]) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text2);padding:20px">Run simulation to see results</td></tr>';
    return;
  }
  const path = paths[pctileIdx];
  const aid = r.annualIncomeData || [];
  const useToday = isTodayMoney();
  const baseInflFactor = 1 + (r.p?.inflation || 0) / 100;
  const yearsToRetirement = Math.max(0, r.p.retirementAge - r.p.currentAge);
  const deflator = yi => Math.pow(1 / baseInflFactor, yearsToRetirement + yi);

  tbody.innerHTML = r.ages.map((age, yi) => {
    const bal = path.balances[yi];
    const dispBal = useToday ? bal * deflator(yi) : bal;
    const change = yi === 0 ? null : path.balances[yi] - path.balances[yi - 1];
    const dispChange = change === null ? null : (useToday ? change * deflator(yi) : change);
    const grossRet = yi === 0 ? null : path.grossReturns[yi - 1];
    const histYear = yi === 0 ? null : path.histYears[yi - 1];
    const histEvent = histYear !== null ? (HIST_YEAR_EVENTS[histYear] || '') : '';
    const incDrawn = aid[yi] ? (useToday ? (aid[yi].withdrawalNom * deflator(yi)) / 12 : aid[yi].withdrawalNom / 12) : 0;
    const cc = dispChange === null ? '' : dispChange >= 0 ? 'color:#16a34a' : 'color:#dc2626';
    const rc = grossRet === null ? '' : grossRet >= 0 ? 'color:#16a34a' : 'color:#dc2626';
    const chStr = dispChange === null ? '—' : (dispChange >= 0 ? '+' : '') + fmtGBP(dispChange);
    const retStr = grossRet === null ? '—' : (grossRet >= 0 ? '+' : '') + fmtPct(grossRet, 1);
    const yearLabel = histYear !== null
      ? `<br><small style="font-weight:400;color:var(--text2)">${histYear}${histEvent ? ' · ' + histEvent : ''}</small>`
      : '';
    return `<tr${bal <= 0 ? ' style="opacity:0.45"' : ''}>
      <td>${age}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums">${fmtGBP(dispBal)}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;${rc}">${retStr}${yearLabel}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;${cc}">${chStr}</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums">${incDrawn > 0 ? fmtGBP(incDrawn) + '/mo' : '—'}</td>
    </tr>`;
  }).join('');
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

function renderTaxBreakdown(r) {
  const selectEl = document.getElementById('tax-year-select');
  const contentEl = document.getElementById('tax-breakdown-content');
  if (!selectEl || !contentEl) return;

  const rows = r?.annualIncomeData || [];
  if (!rows.length) {
    selectEl.innerHTML = '';
    contentEl.innerHTML = '<div style="text-align:center;color:var(--text2);padding:20px">Run simulation to see tax breakdown.</div>';
    return;
  }

  const prevIdx = Number.parseInt(selectEl.value || '0', 10);
  const hasPartner = !!r.p?.partner;
  selectEl.innerHTML = rows.map((d, idx) => {
    const age = hasPartner ? `${d.age}/${d.partnerAge}` : `${d.age}`;
    return `<option value="${idx}">${d.calYear} (Age ${age})</option>`;
  }).join('');

  const selectedIdx = Number.isFinite(prevIdx) ? Math.max(0, Math.min(rows.length - 1, prevIdx)) : 0;
  selectEl.value = String(selectedIdx);

  const d = rows[selectedIdx];
  const useToday = isTodayMoney();

  // ── Inflation factors ──────────────────────────────────────────────────────
  const _infl     = 1 + (r.p?.inflation || 0) / 100;
  const _ytr      = Math.max(0, (r.p?.retirementAge || 0) - (r.p?.currentAge || 0));
  const ciFromNow = Math.pow(_infl, _ytr + selectedIdx);
  const todayDeflator = ciFromNow > 0 ? 1 / ciFromNow : 1;
  const scale     = useToday ? todayDeflator : 1;
  const m = v => (v * scale) / 12;   // nominal annual → monthly display

  // ── Per-source other income items ──────────────────────────────────────────
  const otherItems = calcOtherIncomesNet(r.p?.incomes || [], ciFromNow).items
    .filter(it => it.gross > 0);
  const _partnerRetired = !!(hasPartner && d.partnerAge !== null && d.partnerAge >= r.p.partner.retirementAge);
  const partnerOtherItems = (_partnerRetired && r.p.partner?.incomes?.length)
    ? calcOtherIncomesNet(r.p.partner.incomes, ciFromNow).items.filter(it => it.gross > 0)
    : [];

  // ── Per-person pot fractions from simulation ───────────────────────────────
  const primaryPotFrac = r.primaryPotFrac     ?? 1.0;
  const primaryTFrac   = d.primaryTaxFreeFracAnn ?? r.primaryTaxFreeFrac ?? r.taxFreeFrac;
  const partnerTFrac   = d.partnerTaxFreeFracAnn ?? r.partnerTaxFreeFrac ?? r.taxFreeFrac;

  // ── Nominal annual income figures (tax is computed nominally, as HMRC would) ─
  const hasStatePension   = d.spGrossNom > 0;
  const hasPartnerSP      = (d.partnerSpGrossNom || 0) > 0;
  const primaryDWAnn      = d.pensionGrossNom * 12 * primaryPotFrac;
  const partnerDWAnn      = d.pensionGrossNom * 12 * (1 - primaryPotFrac);
  const spGrossAnn        = d.spGrossNom * 12;
  const partnerSpGrossAnn = (d.partnerSpGrossNom || 0) * 12;
  const cashAnn           = (d.cashNom || 0) * 12;   // tax-free savings/ISA withdrawal

  const fmtA = v => fmtGBP(v / 12) + '/mo  (' + fmtGBP(v) + '/yr)';
  const fmtN = v => v > 0 ? fmtGBP(v) + '/yr' : '—';

  // ── Per-person tax — each gets their own £12,570 personal allowance ─────────
  const yourOtherGross = otherItems.reduce((s, it) => s + it.gross, 0);
  const partOtherGross = partnerOtherItems.reduce((s, it) => s + it.gross, 0);
  const primTc  = calcPensionTax(primaryDWAnn, spGrossAnn, hasStatePension, primaryTFrac, yourOtherGross);
  const partnTc = hasPartner
    ? calcPensionTax(partnerDWAnn, partnerSpGrossAnn, hasPartnerSP, partnerTFrac, partOtherGross)
    : null;

  // ── Summary table row helpers ──────────────────────────────────────────────
  const incRow = (label, gross, tax, net, indent) =>
    `<tr${indent ? ' class="tx-sub-row"' : ''}><td>${label}</td>` +
    `<td class="num">${fmtGBP(gross)}</td><td class="num">${tax === null ? '—' : fmtGBP(tax)}</td><td class="num">${fmtGBP(net)}</td></tr>`;

  const otherRowsHtml = (items, tcOtherTax, totalGross_) => items.map(it => {
    const frac = totalGross_ > 0 ? it.gross / totalGross_ : 0;
    const itemTax = tcOtherTax * frac;
    const itemNet = it.gross - itemTax;
    return `<tr class="tx-sub-row"><td>↳ ${it.name || 'Other Income'}</td>` +
      `<td class="num">${fmtGBP(m(it.gross))}</td><td class="num">${fmtGBP(m(itemTax))}</td><td class="num">${fmtGBP(m(itemNet))}</td></tr>`;
  }).join('');

  const cashRow = cashAnn > 0
    ? `<tr class="tx-sub-row"><td>↳ Cash Savings / ISA<small class="tx-rate">tax-free</small></td>` +
      `<td class="num">${fmtGBP(m(cashAnn))}</td><td class="num">—</td><td class="num">${fmtGBP(m(cashAnn))}</td></tr>`
    : '';

  let summaryTbody, totalGross, totalTax, totalNet;

  if (!hasPartner) {
    summaryTbody =
      incRow('Pension Pots Drawdown', m(primaryDWAnn), m(primTc.pensionTax), m(primTc.pensionNet), false) +
      cashRow +
      (hasStatePension ? incRow('State Pension', m(spGrossAnn), m(primTc.spTax), m(spGrossAnn) - m(primTc.spTax), false) : '') +
      otherRowsHtml(otherItems, primTc.otherTax, yourOtherGross);
    totalGross = m(primaryDWAnn + cashAnn + spGrossAnn + yourOtherGross);
    totalTax   = m(primTc.pensionTax + primTc.spTax + primTc.otherTax);
    totalNet   = totalGross - totalTax;
  } else {
    summaryTbody =
      `<tr class="tx-group-header"><th colspan="4">You</th></tr>` +
      incRow('↳ Pension Pots (your share)', m(primaryDWAnn), m(primTc.pensionTax), m(primTc.pensionNet), true) +
      cashRow +
      (hasStatePension ? incRow('↳ State Pension', m(spGrossAnn), m(primTc.spTax), m(spGrossAnn) - m(primTc.spTax), true) : '') +
      otherRowsHtml(otherItems, primTc.otherTax, yourOtherGross) +
      `<tr class="tx-group-header"><th colspan="4">Partner</th></tr>` +
      incRow('↳ Pension Pots (partner share)', m(partnerDWAnn), m(partnTc.pensionTax), m(partnTc.pensionNet), true) +
      (hasPartnerSP ? incRow('↳ State Pension', m(partnerSpGrossAnn), m(partnTc.spTax), m(partnerSpGrossAnn) - m(partnTc.spTax), true) : '') +
      otherRowsHtml(partnerOtherItems, partnTc.otherTax, partOtherGross);
    totalGross = m(primaryDWAnn + cashAnn + spGrossAnn + yourOtherGross + partnerDWAnn + partnerSpGrossAnn + partOtherGross);
    totalTax   = m(primTc.pensionTax + primTc.spTax + primTc.otherTax + partnTc.pensionTax + partnTc.spTax + partnTc.otherTax);
    totalNet   = totalGross - totalTax;
  }

  // ── Per-person tax workings builder ───────────────────────────────────────
  function personWorkings(label, dwAnn, tfFrac, spAnn, hasSP_, items_) {
    const taxFreeAnn_     = dwAnn * tfFrac;
    const pensionTaxable_ = dwAnn - taxFreeAnn_;
    const otherGross_     = items_.reduce((s, it) => s + it.gross, 0);
    const totalTaxable_   = pensionTaxable_ + (hasSP_ ? spAnn : 0) + otherGross_;
    const bands_          = incomeTaxBands(totalTaxable_);
    const pensionFrac_    = totalTaxable_ > 0 ? pensionTaxable_ / totalTaxable_ : 0;
    const spFrac_         = totalTaxable_ > 0 ? (hasSP_ ? spAnn : 0) / totalTaxable_ : 0;
    const otherFrac_      = totalTaxable_ > 0 ? otherGross_ / totalTaxable_ : 0;
    const pensionTaxAnn_  = bands_.totalTax * pensionFrac_;
    const spTaxAnn_       = bands_.totalTax * spFrac_;
    const otherTaxAnn_    = bands_.totalTax * otherFrac_;

    const tapered_ = bands_.effectivePA < 12570;
    const paNote_  = tapered_
      ? `£${bands_.effectivePA.toLocaleString()} (tapered — income exceeds £100,000)`
      : `£${bands_.effectivePA.toLocaleString()} (standard)`;

    const brRow_ = bands_.brAmount > 0
      ? `<tr><td>${fmtGBP(bands_.brAmount)}/yr × 20% basic rate</td><td class="num">= ${fmtGBP(bands_.brTax)}/yr</td></tr>`
      : `<tr class="tw-nil"><td>Basic rate band</td><td class="num">—</td></tr>`;
    const hrRow_ = bands_.hrAmount > 0
      ? `<tr><td>${fmtGBP(bands_.hrAmount)}/yr × 40% higher rate</td><td class="num">= ${fmtGBP(bands_.hrTax)}/yr</td></tr>`
      : `<tr class="tw-nil"><td>Higher rate band</td><td class="num">—</td></tr>`;
    const arRow_ = bands_.arAmount > 0
      ? `<tr><td>${fmtGBP(bands_.arAmount)}/yr × 45% additional rate</td><td class="num">= ${fmtGBP(bands_.arTax)}/yr</td></tr>`
      : '';

    const step4_ = bands_.totalTax > 0 ? `
      <div class="tw-step">
        <div class="tw-step-title">Step 4 — Tax allocated between income sources</div>
        <p class="tw-step-note">Tax is shared between all taxable income sources in proportion to each source's taxable amount.</p>
        <table class="tw-table">
          ${pensionTaxAnn_ > 0 ? `<tr><td>Pension drawdown share (${fmtPct(pensionFrac_ * 100)})</td><td class="num">= ${fmtGBP(pensionTaxAnn_ / 12)}/mo</td></tr>` : ''}
          ${spTaxAnn_ > 0 ? `<tr><td>State pension share (${fmtPct(spFrac_ * 100)})</td><td class="num">= ${fmtGBP(spTaxAnn_ / 12)}/mo</td></tr>` : ''}
          ${otherTaxAnn_ > 0 ? `<tr><td>Other income share (${fmtPct(otherFrac_ * 100)})</td><td class="num">= ${fmtGBP(otherTaxAnn_ / 12)}/mo</td></tr>` : ''}
          <tr class="tw-total"><td>Total income tax</td><td class="num">${fmtGBP(bands_.totalTax / 12)}/mo</td></tr>
        </table>
      </div>` : '';

    const otherRows_ = items_.map(it => {
      const frac = otherGross_ > 0 ? it.gross / otherGross_ : 0;
      const itemTax = otherTaxAnn_ * frac;
      return `<tr><td>${it.name || 'Income'}</td><td class="num">${fmtGBP(it.gross)}/yr</td><td class="num">${fmtGBP(itemTax)}/yr</td><td class="num">${fmtGBP(it.gross - itemTax)}/yr</td></tr>`;
    }).join('');

    const otherBlock_ = items_.length > 0 ? `
      <div class="tw-step">
        <div class="tw-step-title">Other Income (taxed via UK bands above)</div>
        <table class="tw-table tw-items">
          <tr class="tw-nil"><td>Source</td><td class="num">Gross /yr</td><td class="num">Tax /yr</td><td class="num">Net /yr</td></tr>
          ${otherRows_}
          ${items_.length > 1 ? `<tr class="tw-total"><td>Total</td><td class="num">${fmtGBP(otherGross_)}/yr</td><td class="num">${fmtGBP(otherTaxAnn_)}/yr</td><td class="num">${fmtGBP(otherGross_ - otherTaxAnn_)}/yr</td></tr>` : ''}
        </table>
      </div>` : '';

    return `<div class="tw-person-section">
      <div class="tw-person-heading">${label}</div>
      <div class="tw-step">
        <div class="tw-step-title">Step 1 — Gross income &amp; tax-free cash</div>
        <table class="tw-table">
          ${dwAnn > 0 ? `<tr><td>Pension pot drawdown (gross)</td><td class="num">${fmtN(dwAnn)}</td></tr>
          <tr class="tw-sub"><td>↳ Tax-free portion (${fmtPct(tfFrac * 100)} UFPLS / PCLS)</td><td class="num">− ${fmtN(taxFreeAnn_)}</td></tr>
          <tr class="tw-sub tw-subtotal"><td>↳ Taxable pension drawdown</td><td class="num">${fmtN(pensionTaxable_)}</td></tr>` : ''}
          ${hasSP_ ? `<tr><td>State pension</td><td class="num">${fmtN(spAnn)}</td></tr>` : ''}
          ${items_.map(it => `<tr><td>${it.name || 'Other income'}</td><td class="num">${fmtN(it.gross)}</td></tr>`).join('')}
          <tr class="tw-total"><td>Total taxable income</td><td class="num">${fmtN(totalTaxable_)}</td></tr>
        </table>
      </div>
      <div class="tw-step">
        <div class="tw-step-title">Step 2 — Personal allowance</div>
        <table class="tw-table">
          <tr><td>Personal allowance</td><td class="num">${paNote_}</td></tr>
          <tr><td>Allowance used</td><td class="num">${fmtN(bands_.paUsed)}</td></tr>
          <tr class="tw-total"><td>Income above allowance (taxable)</td><td class="num">${fmtN(bands_.above)}</td></tr>
        </table>
      </div>
      <div class="tw-step">
        <div class="tw-step-title">Step 3 — Tax band calculation</div>
        <table class="tw-table">
          ${brRow_}${hrRow_}${arRow_}
          <tr class="tw-total"><td>Total income tax</td><td class="num">${fmtA(bands_.totalTax)}</td></tr>
        </table>
      </div>
      ${step4_}
      ${otherBlock_}
    </div>`;
  }

  const partnerNote = hasPartner && (1 - primaryPotFrac) > 0.01
    ? `<p class="tw-note" style="margin-top:4px">Pension drawdown is split between you and your partner in proportion to each person's estimated starting pot value. Each person is taxed independently with their own £12,570 personal allowance.</p>`
    : '';

  const workingsHtml = `
    <div class="tw-wrap">
      <div class="tw-heading">How Your Tax Was Calculated</div>
      <p class="tw-note">Figures below are in nominal (actual) money — the amounts HMRC would assess. Tax bands are set by current UK law.</p>
      ${partnerNote}
      ${personWorkings('You', primaryDWAnn, primaryTFrac, spGrossAnn, hasStatePension, otherItems)}
      ${hasPartner ? personWorkings('Partner', partnerDWAnn, partnerTFrac, partnerSpGrossAnn, hasPartnerSP, partnerOtherItems) : ''}
    </div>`;

  contentEl.innerHTML = `
    <table class="tax-summary-table">
      <thead>
        <tr>
          <th style="text-align:left">Income Source</th>
          <th class="num">Gross /mo</th>
          <th class="num">Tax /mo</th>
          <th class="num">Net /mo</th>
        </tr>
      </thead>
      <tbody>
        ${summaryTbody}
        <tr class="tax-total-row">
          <td>Total Household</td>
          <td class="num">${fmtGBP(totalGross)}</td>
          <td class="num">${fmtGBP(totalTax)}</td>
          <td class="num">${fmtGBP(totalNet)}</td>
        </tr>
      </tbody>
    </table>
    ${workingsHtml}`;
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
        ...(r.p?.partner ? [{ label: 'Partner SP', data: makeSeries('partnerSp'), backgroundColor: '#86efac', stack: 'a' }] : []),
        ...(r.p?.partner?.incomes?.length ? [{ label: 'Partner Income', data: makeSeries('partnerOther'), backgroundColor: '#f59e0b', stack: 'a' }] : []),
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
const tabDefs = ['pot', 'annualincome', 'swr', 'taxbreakdown', 'realincome', 'netmonthly', 'montecarlo'];
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
      else if (tab === 'taxbreakdown') renderTaxBreakdown(lastResults);
      else if (tab === 'realincome') renderRealIncomeChart(lastResults);
      else if (tab === 'netmonthly') renderNetMonthlyChart(lastResults);
      else if (tab === 'annualincome') { renderAnnualIncomeChart(lastResults); renderAnnualIncomeTable(lastResults); }
      else if (tab === 'montecarlo') { renderMonteCarloChart(lastResults); renderMonteCarloTable(lastResults, +document.getElementById('mc-pctile').value); }
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
      const r = runSimulation();
      if (!r) {
        document.getElementById('income-tbody').innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text2);padding:20px">Simulation failed: check retirement/end ages</td></tr>';
        ['c-prob','c-guardrail-sub','c-median','c-swr','c-actual-rate','c-monthly'].forEach(id => {
          const el = document.getElementById(id);
          if (el) el.textContent = '—';
        });
        const taxContent = document.getElementById('tax-breakdown-content');
        if (taxContent) taxContent.innerHTML = '<div style="text-align:center;color:var(--text2);padding:20px">Run simulation to see tax breakdown.</div>';
        renderExplainability(null, null);
        return;
      }
      r.annualIncomeData = buildAnnualIncomeData(r);

      renderCards(r);
      const explain = buildExplainability(getParams(), r);
      renderExplainability(explain, r);
      renderIncomeTable(r);

      if (activeTab === 'pot') renderPotChart(r);
      else if (activeTab === 'swr') renderSWRChart(r);
      else if (activeTab === 'taxbreakdown') renderTaxBreakdown(r);
      else if (activeTab === 'realincome') renderRealIncomeChart(r);
      else if (activeTab === 'netmonthly') renderNetMonthlyChart(r);
      else if (activeTab === 'annualincome') { renderAnnualIncomeChart(r); renderAnnualIncomeTable(r); }
      else if (activeTab === 'montecarlo') { renderMonteCarloChart(r); renderMonteCarloTable(r, +document.getElementById('mc-pctile').value); }

      setActiveTab(activeTab);
    } catch (err) {
      console.error('Run simulation failed', err);
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

  // Preset buttons for return rate (and any future preset buttons)
  document.querySelectorAll('.preset-btn[data-target]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target);
      const labelId = btn.dataset.label;
      if (!target) return;
      target.value = btn.dataset.value;
      if (labelId) {
        const lbl = document.getElementById(labelId);
        const slider = sliders.find(([id]) => id === btn.dataset.target);
        if (lbl && slider) lbl.textContent = slider[1](+btn.dataset.value);
      }
      // Update active styling
      document.querySelectorAll(`.preset-btn[data-target="${btn.dataset.target}"]`).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      persistParams();
    });
  });
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

  const addPartnerPotBtn = document.getElementById('add-partner-pot-btn');
  if (addPartnerPotBtn) addPartnerPotBtn.addEventListener('click', () => { addPartnerPot(0, 0, 80); persistParams(); });

  const addPartnerCashPotBtn = document.getElementById('add-partner-cash-pot-btn');
  if (addPartnerCashPotBtn) addPartnerCashPotBtn.addEventListener('click', () => { addPartnerCashPot(0, 3.5); persistParams(); });

  const addPartnerIncomeBtn = document.getElementById('add-partner-income-btn');
  if (addPartnerIncomeBtn) addPartnerIncomeBtn.addEventListener('click', () => { addPartnerIncome('Income source', 0, 'annual', 20); persistParams(); });

  // Partner toggle
  const partnerCb = document.getElementById('partner-enabled');
  if (partnerCb) {
    partnerCb.addEventListener('change', () => {
      document.getElementById('partner-section').classList.toggle('hidden', !partnerCb.checked);
      persistParams();
    });
  }

  // Partner age validation: retirement age min tracks current age
  const partnerAgeEl = document.getElementById('partner-age');
  const partnerRetEl = document.getElementById('partner-retirement-age');
  if (partnerAgeEl && partnerRetEl) {
    partnerAgeEl.addEventListener('input', () => {
      const minAge = +partnerAgeEl.value;
      if (+partnerRetEl.value < minAge) {
        partnerRetEl.value = minAge;
        const label = document.getElementById('v-partner-retirement-age');
        if (label) label.textContent = minAge;
      }
      partnerRetEl.min = minAge;
    });
  }

  const mcPctileSlider = document.getElementById('mc-pctile');
  const mcPctileLabel  = document.getElementById('v-mc-pctile');
  mcPctileSlider.addEventListener('input', () => {
    const idx = +mcPctileSlider.value;
    mcPctileLabel.textContent = MC_PCT_LABELS[idx];
    if (lastResults) renderMonteCarloTable(lastResults, idx);
  });

  const taxYearSelect = document.getElementById('tax-year-select');
  if (taxYearSelect) {
    taxYearSelect.addEventListener('change', () => {
      if (lastResults) renderTaxBreakdown(lastResults);
    });
  }

  // Try to restore persisted state; fall back to defaults
  const saved = loadPersistedParams();
  if (saved) {
    restoreParams(saved);
    // If no pots were restored, seed defaults
    if (potsData.length === 0) {
      addPot(500000, 10000, 70);
    }
    // If no incomes were restored, seed defaults
    if (incomesData.length === 0) {
      addIncome('Property income', 12000, 'annual', 22, true);
    }
    if (cashPotsData.length === 0) {
      addCashPot(50000, 3.5);
    }
  } else {
    // First-run defaults
    addPot(500000, 10000, 70);
    addIncome('Property income', 12000, 'annual', 22, true);
    addCashPot(50000, 3.5);
    // Partner first-run defaults (disabled)
    addPartnerPot(250000, 5000, 70);
    addPartnerCashPot(25000, 3.5);
  }

  // Activate preset button matching each slider's initial value on page load
  document.querySelectorAll('.preset-btn[data-target]').forEach(btn => {
    const target = document.getElementById(btn.dataset.target);
    if (target && +btn.dataset.value === +target.value) btn.classList.add('active');
  });

  // Re-persist now that all pots/incomes/cash pots are fully initialised.
  // Slider input dispatches during restoreParams call persistParams before pots are loaded,
  // so this final call overwrites storage with the complete correct state.
  persistParams();

  document.getElementById('run-btn').click();
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
