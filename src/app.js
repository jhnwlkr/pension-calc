import { fmt, fmtGBP, fmtPct, fmtAxisGBP } from './utils.js';
import { LSA, FORMER_LTA, HIST_EQUITY_RETURNS, HIST_BONDS_RETURNS,
  PA, BR_LIMIT, HR_LIMIT, BR_RATE, HR_RATE, AR_RATE,
  PROP_SAV_BR_RATE, PROP_SAV_HR_RATE, PROP_SAV_AR_RATE, PROP_SAV_RATE_CHANGE_YEAR,
  DIV_BR_RATE, DIV_HR_RATE, DIV_AR_RATE, DIV_BR_RATE_OLD, DIV_HR_RATE_OLD, DIV_RATE_CHANGE_YEAR,
} from './constants.js';
import { incomeTax, incomeTaxBands, calcPensionTax, calcOtherIncomesNet, calcDbIncome } from './model.js';
import { runSimulation as runSimulationImpl, runDeterministicProjection } from './simulation.js';

// ── Dynamic Pots State ─────────────────────────────────────────────────────
let nextPotId = 1;
let potsData = [];
let todayPrices = false; // Shared today’s-prices toggle state
let groupsData = [];         // Pension pot groups: [{ uuid, name }]
let partnerGroupsData = [];  // Partner pension pot groups
let spendingGoalsData = [];  // Spending goals: [{ id, label, startAge, endAge, extraAnnual }]
let nextGoalId = 1;
let baselineSnapshot = null; // Saved scenario for comparison


function addPot(value, annualContrib, equityPct, name) {
  const id = nextPotId++;
  potsData.push({
    id,
    uuid: crypto.randomUUID(),
    name: name || '',
    value: (value !== undefined && value !== null) ? +value : 0,
    annualContrib: (annualContrib !== undefined && annualContrib !== null) ? +annualContrib : 0,
    equityPct: (equityPct !== undefined && equityPct !== null) ? +equityPct : 80,
    glideEnabled: false,
    glideTargetPct: 40,
    glideTargetAge: 75,
    groupUuid: null,
    groupAllocationPct: null,
    archived: false,
    archivedDate: null,
    consolidatedIntoUuid: null,
  });
  renderPotsUI();
}

function removePot(id) {
  if (potsData.length <= 1) return; // keep at least one
  const _leaving = potsData.find(p => p.id === id);
  const _oldGroup = _leaving?.groupUuid;
  potsData = potsData.filter(p => p.id !== id);
  if (_oldGroup) dissolveIfSingleMember(_oldGroup, potsData, groupsData);
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
        <span class="pot-card-title" id="pot-title-${pot.id}">${pot.name || ('Pot ' + (idx + 1))}${pot.archived ? ' <span class="archived-badge">Archived</span>' : ''}</span>
        ${potsData.length > 1 ? `<button class="remove-btn" data-pot-id="${pot.id}" data-pot-set="user" title="${isActualsEnabled() ? 'Archive / consolidate / delete' : 'Close pot'}">${isActualsEnabled() ? '⋯' : '✕'}</button>` : ''}
      </div>
      <div style="margin-bottom:8px">
        <input class="dyn-input" type="text" placeholder="Name (optional, e.g. SIPP)"
          data-pot-id="${pot.id}" data-field="name"
          value="${(pot.name || '').replace(/"/g, '&quot;')}"
          style="font-size:0.8rem;color:var(--text2)">
      </div>
      ${buildGroupRowHTML(pot, groupsData, 'pot-id', '')}
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
      </div>
      <div style="margin-top:8px">
        <label style="display:flex;align-items:center;gap:6px;font-size:0.82rem;cursor:pointer;font-weight:500">
          <input type="checkbox" class="pot-glide-toggle" data-pot-id="${pot.id}" ${pot.glideEnabled ? 'checked' : ''} style="accent-color:var(--accent)">
          Glide path (reduce equity over time)
        </label>
        <div class="pot-glide-fields" style="margin-top:6px;display:flex;gap:12px;flex-wrap:wrap;${pot.glideEnabled ? '' : 'display:none'}">
          <div style="${pot.glideEnabled ? '' : 'display:none'}">
            <span class="field-label">Target equity %</span>
            <input class="dyn-input" type="number" min="0" max="100" step="5" value="${pot.glideTargetPct ?? 40}" data-pot-id="${pot.id}" data-field="glideTargetPct" style="width:70px">
          </div>
          <div style="${pot.glideEnabled ? '' : 'display:none'}">
            <span class="field-label">By age</span>
            <input class="dyn-input" type="number" min="50" max="95" value="${pot.glideTargetAge ?? 75}" data-pot-id="${pot.id}" data-field="glideTargetAge" style="width:70px">
          </div>
        </div>
      </div>`;
    container.appendChild(div);
  });

  // Wire action buttons
  container.querySelectorAll('.remove-btn[data-pot-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (isActualsEnabled()) openPotModal(+btn.dataset.potId, 'user');
      else quickClosePot(+btn.dataset.potId, 'user');
    });
  });

  // Wire number inputs
  container.querySelectorAll('.dyn-input[data-pot-id]').forEach(inp => {
    inp.addEventListener('input', () => {
      const potId = +inp.dataset.potId;
      const field = inp.dataset.field;
      const pot = potsData.find(p => p.id === potId);
      if (pot) {
        if (field === 'name') {
          pot.name = inp.value;
          const titleEl = document.getElementById('pot-title-' + potId);
          if (titleEl) titleEl.textContent = inp.value || ('Pot ' + (potsData.indexOf(pot) + 1));
        } else {
          pot[field] = +inp.value;
        }
      }
      if (field === 'groupAllocationPct') validateGroupAllocations(groupsData, potsData, '');
      persistParams();
    });
  });

  // Wire group selects
  container.querySelectorAll('.pot-group-select[data-pot-id]').forEach(sel => {
    sel.addEventListener('change', () => {
      const potId = +sel.dataset.potId;
      const pot = potsData.find(p => p.id === potId);
      if (!pot) return;
      if (sel.value === '__new__') {
        sel.value = pot.groupUuid || '';
        const row = document.getElementById('group-create-' + potId);
        if (row) { row.style.display = 'flex'; document.getElementById('group-create-input-' + potId)?.focus(); }
      } else {
        const oldGroup = pot.groupUuid;
        pot.groupUuid = sel.value || null;
        pot.groupAllocationPct = sel.value
          ? (potsData.filter(p => p.groupUuid === sel.value).length === 0 ? 100 : 0)
          : null;
        if (oldGroup && oldGroup !== sel.value) dissolveIfSingleMember(oldGroup, potsData, groupsData);
        validateGroupAllocations(groupsData, potsData, '');
        renderPotsUI();
        persistParams();
      }
    });
  });

  // Wire group create forms
  potsData.forEach(pot => {
    const row = document.getElementById('group-create-' + pot.id);
    const input = document.getElementById('group-create-input-' + pot.id);
    const addBtn = document.getElementById('group-create-btn-' + pot.id);
    const cancelBtn = document.getElementById('group-create-cancel-' + pot.id);
    const doCreate = () => {
      const name = input?.value.trim();
      if (!name) return;
      const newGroup = { uuid: crypto.randomUUID(), name };
      groupsData.push(newGroup);
      pot.groupUuid = newGroup.uuid;
      pot.groupAllocationPct = 100;
      renderPotsUI();
      persistParams();
    };
    addBtn?.addEventListener('click', doCreate);
    input?.addEventListener('keydown', e => { if (e.key === 'Enter') doCreate(); });
    cancelBtn?.addEventListener('click', () => { if (row) row.style.display = 'none'; });
  });

  validateGroupAllocations(groupsData, potsData, '');

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

  // Wire glide path toggles and fields
  container.querySelectorAll('.pot-glide-toggle').forEach(cb => {
    cb.addEventListener('change', () => {
      const potId = +cb.dataset.potId;
      const pot = potsData.find(p => p.id === potId);
      if (pot) {
        pot.glideEnabled = cb.checked;
        const fields = cb.closest('div').nextElementSibling;
        if (fields) fields.querySelectorAll('div').forEach(d => { d.style.display = cb.checked ? '' : 'none'; });
      }
      persistParams();
    });
  });
  container.querySelectorAll('.dyn-input[data-field="glideTargetPct"], .dyn-input[data-field="glideTargetAge"]').forEach(inp => {
    inp.addEventListener('input', () => {
      const potId = +inp.dataset.potId;
      const pot = potsData.find(p => p.id === potId);
      if (pot) pot[inp.dataset.field] = +inp.value;
      persistParams();
    });
  });
}

// Dynamic control wiring is done in initApp() to avoid DOM timing issues when the script is loaded.

// ── Pot action modal ───────────────────────────────────────────────────────
function quickClosePot(potId, potSet) {
  const pots = potSet === 'partner' ? partnerPotsData : potsData;
  const groups = potSet === 'partner' ? partnerGroupsData : groupsData;
  const pot = pots.find(p => p.id === potId);
  if (!pot) return;
  const hasEntries = actualsEvents.some(e => e.potUuid === pot.uuid);
  if (hasEntries) {
    pot.archived = true;
    pot.archivedDate = new Date().toISOString().slice(0, 10);
  } else {
    if (potSet === 'user' && potsData.filter(p => !p.archived).length <= 1 && !pot.archived) return;
    const oldGroup = pot.groupUuid;
    if (potSet === 'partner') {
      partnerPotsData = partnerPotsData.filter(p => p.id !== potId);
    } else {
      potsData = potsData.filter(p => p.id !== potId);
    }
    if (oldGroup) dissolveIfSingleMember(oldGroup, pots, groups);
  }
  potSet === 'partner' ? renderPartnerPotsUI() : renderPotsUI();
  persistParams();
}

let _potModalState = { potId: null, potSet: 'user' };

function openPotModal(potId, potSet) {
  const pots = potSet === 'partner' ? partnerPotsData : potsData;
  const pot = pots.find(p => p.id === potId);
  if (!pot) return;

  _potModalState = { potId, potSet };

  const title = document.getElementById('pot-modal-title');
  const sub   = document.getElementById('pot-modal-sub');
  if (title) title.textContent = pot.name || ('Pot ' + (pots.indexOf(pot) + 1));
  if (sub)   sub.textContent   = pot.archived ? 'This pot is currently archived.' : fmtGBP(pot.value) + ' current value';

  // Archive vs Unarchive
  document.getElementById('pot-modal-archive').style.display   = pot.archived ? 'none' : '';
  document.getElementById('pot-modal-unarchive').style.display = pot.archived ? ''     : 'none';

  // Consolidate — only available for active (non-archived) pots with other active pots to merge into
  const others = pots.filter(p => p.id !== potId && !p.archived);
  const consolidateBtn = document.getElementById('pot-modal-consolidate-btn');
  if (consolidateBtn) consolidateBtn.style.display = (!pot.archived && others.length) ? '' : 'none';

  // Reset consolidate row
  const consolidateRow = document.getElementById('pot-modal-consolidate-row');
  if (consolidateRow) consolidateRow.style.display = 'none';
  const sel = document.getElementById('pot-modal-consolidate-select');
  if (sel) {
    sel.innerHTML = others.map((p, i) =>
      `<option value="${p.id}">${p.name || ('Pot ' + (pots.indexOf(p) + 1))} — ${fmtGBP(p.value)}</option>`
    ).join('');
  }

  // Delete — disabled when only 1 pot (for user pots); always allowed for partner
  const deleteBtn = document.getElementById('pot-modal-delete');
  if (deleteBtn) {
    const tooFew = potSet === 'user' && potsData.filter(p => !p.archived).length <= 1 && !pot.archived;
    deleteBtn.disabled = tooFew;
    deleteBtn.title = tooFew ? 'Cannot delete the last active pot' : '';
  }

  document.getElementById('pot-action-modal').classList.remove('hidden');
}

function closePotModal() {
  document.getElementById('pot-action-modal').classList.add('hidden');
  _potModalState = { potId: null, potSet: 'user' };
}

function initPotModal() {
  const modal = document.getElementById('pot-action-modal');

  // Backdrop click closes
  modal.addEventListener('click', e => { if (e.target === modal) closePotModal(); });
  document.getElementById('pot-modal-cancel').addEventListener('click', closePotModal);

  // Archive
  document.getElementById('pot-modal-archive').addEventListener('click', () => {
    const { potId, potSet } = _potModalState;
    const pots = potSet === 'partner' ? partnerPotsData : potsData;
    const pot = pots.find(p => p.id === potId);
    if (!pot) return;
    pot.archived = true;
    pot.archivedDate = new Date().toISOString().slice(0, 10);
    closePotModal();
    potSet === 'partner' ? renderPartnerPotsUI() : renderPotsUI();
    persistParams();
  });

  // Unarchive
  document.getElementById('pot-modal-unarchive').addEventListener('click', () => {
    const { potId, potSet } = _potModalState;
    const pots = potSet === 'partner' ? partnerPotsData : potsData;
    const pot = pots.find(p => p.id === potId);
    if (!pot) return;
    pot.archived = false;
    pot.archivedDate = null;
    pot.consolidatedIntoUuid = null;
    closePotModal();
    potSet === 'partner' ? renderPartnerPotsUI() : renderPotsUI();
    persistParams();
  });

  // Consolidate — show target selector
  document.getElementById('pot-modal-consolidate-btn').addEventListener('click', () => {
    const row = document.getElementById('pot-modal-consolidate-row');
    if (row) row.style.display = row.style.display === 'none' ? 'block' : 'none';
  });

  // Consolidate — confirm
  document.getElementById('pot-modal-consolidate-confirm').addEventListener('click', () => {
    const { potId, potSet } = _potModalState;
    const pots = potSet === 'partner' ? partnerPotsData : potsData;
    const groups = potSet === 'partner' ? partnerGroupsData : groupsData;
    const pot = pots.find(p => p.id === potId);
    const targetId = +document.getElementById('pot-modal-consolidate-select').value;
    const target = pots.find(p => p.id === targetId);
    if (!pot || !target) return;

    // Merge value and contributions into target
    target.value += pot.value;
    target.annualContrib += pot.annualContrib;

    // Mark source as consolidated
    pot.archived = true;
    pot.archivedDate = new Date().toISOString().slice(0, 10);
    pot.consolidatedIntoUuid = target.uuid;

    // Handle group dissolution
    if (pot.groupUuid) dissolveIfSingleMember(pot.groupUuid, pots, groups);

    closePotModal();
    potSet === 'partner' ? renderPartnerPotsUI() : renderPotsUI();
    persistParams();
  });

  // Delete
  document.getElementById('pot-modal-delete').addEventListener('click', () => {
    const { potId, potSet } = _potModalState;
    const pots = potSet === 'partner' ? partnerPotsData : potsData;
    const groups = potSet === 'partner' ? partnerGroupsData : groupsData;
    const pot = pots.find(p => p.id === potId);
    if (!pot) return;
    if (potSet === 'user' && potsData.filter(p => !p.archived).length <= 1 && !pot.archived) return;
    const oldGroup = pot.groupUuid;
    if (potSet === 'partner') {
      partnerPotsData = partnerPotsData.filter(p => p.id !== potId);
    } else {
      potsData = potsData.filter(p => p.id !== potId);
    }
    if (oldGroup) dissolveIfSingleMember(oldGroup, pots, groups);
    closePotModal();
    potSet === 'partner' ? renderPartnerPotsUI() : renderPotsUI();
    persistParams();
  });
}

// ── Pot group helpers ──────────────────────────────────────────────────────
function dissolveIfSingleMember(groupUuid, pots, groups) {
  const members = pots.filter(p => p.groupUuid === groupUuid);
  if (members.length < 2) {
    members.forEach(p => { p.groupUuid = null; p.groupAllocationPct = null; });
    const idx = groups.findIndex(g => g.uuid === groupUuid);
    if (idx !== -1) groups.splice(idx, 1);
  }
}

function validateGroupAllocations(groups, pots, idPfx) {
  groups.forEach(group => {
    const members = pots.filter(p => p.groupUuid === group.uuid);
    const total = members.reduce((s, p) => s + (p.groupAllocationPct || 0), 0);
    const ok = Math.abs(total - 100) < 0.5;
    members.forEach(p => {
      const el = document.getElementById(idPfx + 'group-alloc-warn-' + p.id);
      if (el) el.style.display = ok ? 'none' : 'block';
    });
  });
}

function buildGroupRowHTML(pot, groups, potAttr, idPfx) {
  const esc = s => String(s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
  const opts = groups.map(g =>
    `<option value="${g.uuid}"${pot.groupUuid === g.uuid ? ' selected' : ''}>${esc(g.name)}</option>`
  ).join('');
  const allocInput = pot.groupUuid ? `
      <div class="input-group" style="width:88px;flex-shrink:0">
        <input class="dyn-input" type="number" min="0" max="100" step="5"
          data-${potAttr}="${pot.id}" data-field="groupAllocationPct"
          value="${pot.groupAllocationPct ?? 100}" style="text-align:right">
        <span class="input-suffix">%</span>
      </div>` : '';
  const warnEl = pot.groupUuid
    ? `<div id="${idPfx}group-alloc-warn-${pot.id}" style="display:none;font-size:0.72rem;color:#f59e0b;margin-top:3px">Allocations in this group don't sum to 100%</div>`
    : '';
  return `
    <div style="margin-bottom:8px">
      <span class="field-label">Group <span style="font-weight:400;font-size:0.72rem">(optional)</span></span>
      <div style="display:flex;gap:6px;align-items:center">
        <select class="dyn-select pot-group-select" data-${potAttr}="${pot.id}" style="flex:1">
          <option value="">No group</option>
          ${opts}
          <option value="__new__">+ New group…</option>
        </select>
        ${allocInput}
      </div>
      ${warnEl}
      <div id="${idPfx}group-create-${pot.id}" style="display:none;margin-top:5px;flex-wrap:wrap;gap:5px;align-items:center">
        <input type="text" placeholder="Group name (e.g. Vanguard SIPP)"
          id="${idPfx}group-create-input-${pot.id}"
          class="dyn-input" style="flex:1;min-width:120px;border:1px solid var(--border);border-radius:5px;padding:4px 7px;font-size:0.8rem">
        <button class="add-btn" id="${idPfx}group-create-btn-${pot.id}" style="padding:3px 9px;font-size:0.75rem">Add</button>
        <button id="${idPfx}group-create-cancel-${pot.id}" style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:0.82rem;line-height:1;padding:3px 4px">✕</button>
      </div>
    </div>`;
}

// ── Dynamic Incomes State ──────────────────────────────────────────────────
let nextIncomeId = 1;
let incomesData = [];

function addIncome(name, amount, frequency, inflationLinked = false, incomePeriod = false, startAge = undefined, endAge = undefined, inflationBase = 'real', incomeType = 'employment') {
  const id = nextIncomeId++;
  incomesData.push({
    id,
    uuid: crypto.randomUUID(),
    name: name || 'Income source',
    amount: amount !== undefined ? amount : 0,
    frequency: frequency || 'annual',
    inflationLinked,
    incomePeriod,
    startAge,
    endAge,
    inflationBase,
    incomeType,
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
  const retAge = +document.getElementById('retirement-age').value || 65;
  const curAge = dobToAge(document.getElementById('current-dob').value) || 18;
  incomesData.forEach(inc => {
    const div = document.createElement('div');
    div.className = 'income-card';
    const startVal = inc.startAge ?? '';
    const endVal = inc.endAge ?? '';
    const periodDisabled = inc.incomePeriod ? '' : 'disabled';
    const nominalLabel = inc.incomePeriod ? 'From Start Age' : 'From Retirement';
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
      <div class="inc-row">
        <label class="field-label" style="min-width:60px">Type</label>
        <select class="dyn-select" data-inc-id="${inc.id}" data-field="incomeType">
          <option value="employment" ${(inc.incomeType || 'employment') === 'employment' ? 'selected' : ''}>Employment / Trading</option>
          <option value="property"   ${inc.incomeType === 'property'   ? 'selected' : ''}>Property / Rental</option>
          <option value="savings"    ${inc.incomeType === 'savings'    ? 'selected' : ''}>Savings / Interest</option>
          <option value="dividends"  ${inc.incomeType === 'dividends'  ? 'selected' : ''}>Dividends</option>
        </select>
      </div>
      <div class="inc-row">
        <label><input type="checkbox" data-inc-id="${inc.id}" data-field="incomePeriod" ${inc.incomePeriod ? 'checked' : ''}> Period</label>
        <div class="inc-age-inputs">
          <label>From age <input type="number" class="inc-age-input" min="${curAge}" max="999" maxlength="3" data-inc-id="${inc.id}" data-field="startAge" value="${startVal}" ${periodDisabled} placeholder="${retAge}"></label>
          <label>Until age <input type="number" class="inc-age-input" min="${curAge}" max="999" maxlength="3" data-inc-id="${inc.id}" data-field="endAge" value="${endVal}" ${periodDisabled} placeholder="ever"></label>
        </div>
      </div>
      <div class="inc-row">
        <label><input type="checkbox" data-inc-id="${inc.id}" data-field="inflationLinked" ${inc.inflationLinked ? 'checked' : ''}> Increases with inflation</label>
      </div>
      ${inc.inflationLinked ? `
      <div class="inc-row inc-infl-base">
        <label><input type="radio" name="inflBase-${inc.id}" data-inc-id="${inc.id}" data-field="inflationBase" value="real" ${inc.inflationBase !== 'nominal' ? 'checked' : ''}> From Today</label>
        <label><input type="radio" name="inflBase-${inc.id}" data-inc-id="${inc.id}" data-field="inflationBase" value="nominal" ${inc.inflationBase === 'nominal' ? 'checked' : ''}> ${nominalLabel}</label>
      </div>` : ''}`;
    container.appendChild(div);
  });

  // Wire remove buttons
  container.querySelectorAll('.remove-btn[data-inc-id]').forEach(btn => {
    btn.addEventListener('click', () => removeIncome(+btn.dataset.incId));
  });

  // Wire inputs
  container.querySelectorAll('[data-inc-id]').forEach(el => {
    const evName = (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'radio') ? 'change' : 'input';
    el.addEventListener(evName, () => {
      const incId = +el.dataset.incId;
      const field = el.dataset.field;
      const inc = incomesData.find(i => i.id === incId);
      if (!inc) return;
      if (field === 'incomePeriod') {
        inc.incomePeriod = el.checked;
        if (el.checked && !inc.startAge) {
          inc.startAge = +document.getElementById('retirement-age').value || 65;
        }
        persistParams();
        renderIncomesUI();
        return;
      }
      if (field === 'inflationLinked') {
        inc.inflationLinked = el.checked;
        persistParams();
        renderIncomesUI();
        return;
      }
      if (field === 'inflationBase') {
        inc.inflationBase = el.value;
      } else if (field === 'name' || field === 'frequency' || field === 'incomeType') {
        inc[field] = el.value;
      } else if (field === 'startAge' || field === 'endAge') {
        if (el.value.length > 3) { el.value = el.value.slice(0, 3); }
        inc[field] = el.value !== '' ? +el.value : undefined;
      } else {
        inc[field] = +el.value;
      }
      persistParams();
    });
  });
  container.querySelectorAll('.inc-age-input[data-inc-id]').forEach(el => {
    el.addEventListener('blur', () => {
      const inc = incomesData.find(i => i.id === +el.dataset.incId);
      if (!inc) return;
      const field = el.dataset.field;
      const targetEndAge = +document.getElementById('end-age').value || 100;
      let changed = false;
      if (field === 'endAge' && inc.endAge !== undefined) {
        if (inc.endAge > targetEndAge) { inc.endAge = targetEndAge; changed = true; }
        if (inc.startAge !== undefined && inc.endAge <= inc.startAge) { inc.endAge = inc.startAge + 1; changed = true; }
        if (changed) el.value = inc.endAge;
      } else if (field === 'startAge' && inc.startAge !== undefined) {
        if (inc.startAge > targetEndAge) { inc.startAge = targetEndAge - 1; el.value = inc.startAge; changed = true; }
        if (inc.endAge !== undefined && inc.startAge >= inc.endAge) {
          inc.endAge = inc.startAge + 1;
          const endEl = container.querySelector(`.inc-age-input[data-inc-id="${inc.id}"][data-field="endAge"]`);
          if (endEl) endEl.value = inc.endAge;
          changed = true;
        }
      }
      if (changed) persistParams();
    });
  });
}

// add-income button wiring is initialized in initApp().

// ── DB Pension State ───────────────────────────────────────────────────────
let nextDbPensionId = 1;
let dbPensionsData = [];

function addDbPension(name, startAge, preSpAnnual, postSpAnnual) {
  const id = nextDbPensionId++;
  dbPensionsData.push({
    id,
    name: name || '',
    startAge: startAge !== undefined ? +startAge : undefined,
    preSpAnnual: preSpAnnual !== undefined ? +preSpAnnual : 0,
    postSpAnnual: postSpAnnual !== undefined ? +postSpAnnual : 0,
  });
  renderDbPensionsUI();
}

function removeDbPension(id) {
  dbPensionsData = dbPensionsData.filter(d => d.id !== id);
  renderDbPensionsUI();
  persistParams();
}

function renderDbPensionsUI() {
  const container = document.getElementById('db-pensions-container');
  if (!container) return;
  container.innerHTML = '';
  if (dbPensionsData.length === 0) {
    container.innerHTML = '<div style="font-size:0.78rem;color:var(--text2);padding:6px 0">No DB pensions added.</div>';
    return;
  }
  const retAge = +document.getElementById('retirement-age').value || 65;
  dbPensionsData.forEach(db => {
    const div = document.createElement('div');
    div.className = 'income-card';
    div.innerHTML = `
      <div class="income-card-header">
        <div class="input-group" style="flex:1;margin-right:6px">
          <input class="dyn-input" type="text" placeholder="Scheme name" data-db-id="${db.id}" data-field="name" value="${(db.name || '').replace(/"/g,'&quot;')}" style="font-weight:600">
        </div>
        <button class="remove-btn" data-db-id="${db.id}">✕</button>
      </div>
      <div class="two-col">
        <div>
          <span class="field-label">Starts at age</span>
          <div class="input-group">
            <input class="dyn-input" type="number" min="50" max="90" step="1" data-db-id="${db.id}" data-field="startAge" value="${db.startAge ?? retAge}" placeholder="${retAge}">
          </div>
        </div>
        <div>
          <span class="field-label">Pre state pension age (£/yr)</span>
          <div class="input-group">
            <span class="input-prefix">£</span>
            <input class="dyn-input" type="number" min="0" step="100" data-db-id="${db.id}" data-field="preSpAnnual" value="${db.preSpAnnual}">
          </div>
        </div>
      </div>
      <div class="inc-row" style="margin-top:6px">
        <span class="field-label">Post state pension age (£/yr)</span>
        <div class="input-group" style="width:140px">
          <span class="input-prefix">£</span>
          <input class="dyn-input" type="number" min="0" step="100" data-db-id="${db.id}" data-field="postSpAnnual" value="${db.postSpAnnual}">
        </div>
      </div>
      <div style="font-size:0.72rem;color:var(--text2);margin-top:4px">Amounts in today's money. Taxed as employment income.</div>`;
    container.appendChild(div);
  });

  container.querySelectorAll('.remove-btn[data-db-id]').forEach(btn => {
    btn.addEventListener('click', () => removeDbPension(+btn.dataset.dbId));
  });
  container.querySelectorAll('[data-db-id]').forEach(el => {
    const evName = el.type === 'text' ? 'input' : 'input';
    el.addEventListener(evName, () => {
      const dbId = +el.dataset.dbId;
      const field = el.dataset.field;
      const db = dbPensionsData.find(d => d.id === dbId);
      if (!db) return;
      if (field === 'name') {
        db.name = el.value;
      } else {
        db[field] = el.value !== '' ? +el.value : undefined;
      }
      persistParams();
    });
  });
}

// ── Dynamic Cash Pots State ────────────────────────────────────────────────
let nextCashPotId = 1;
let cashPotsData = [];

function addCashPot(value, interestPct, name, monthlyContrib, contribStartMonth, valueFromYear, type, equityPct) {
  const id = nextCashPotId++;
  const t = type || 'cash';
  const mktLinked = t === 'ss_isa' || t === 'lisa';
  cashPotsData.push({
    id,
    uuid: crypto.randomUUID(),
    name: name || '',
    type: t,
    value: (value !== undefined && value !== null) ? +value : 0,
    interestPct: mktLinked ? 0 : (interestPct !== undefined && interestPct !== null ? +interestPct : 3.5),
    equityPct: mktLinked ? (equityPct !== undefined && equityPct !== null ? +equityPct : 80) : 80,
    monthlyContrib: (monthlyContrib !== undefined && monthlyContrib !== null) ? +monthlyContrib : 0,
    contribStartMonth: contribStartMonth || new Date().toISOString().slice(0, 7),
    valueFromAge: valueFromYear ? +valueFromYear : undefined,
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

  // ISA allowance warning
  const isaAnnual = cashPotsData.filter(p => p.type && p.type !== 'cash').reduce((s, p) => s + (p.monthlyContrib || 0) * 12, 0);
  const lisaAnnual = cashPotsData.filter(p => p.type === 'lisa').reduce((s, p) => s + (p.monthlyContrib || 0) * 12, 0);
  if (isaAnnual > 20000 || lisaAnnual > 4000) {
    const msg = isaAnnual > 20000
      ? `⚠ ISA contributions £${Math.round(isaAnnual).toLocaleString()}/yr exceed the £20,000 annual ISA allowance`
      : `⚠ LISA contributions £${Math.round(lisaAnnual).toLocaleString()}/yr exceed the £4,000 annual LISA limit`;
    const warn = document.createElement('div');
    warn.style.cssText = 'font-size:0.74rem;color:#dc2626;padding:5px 8px;background:#fef2f2;border:1px solid #fca5a5;border-radius:4px;margin-bottom:6px';
    warn.textContent = msg;
    container.appendChild(warn);
  }

  if (cashPotsData.length === 0) {
    container.insertAdjacentHTML('beforeend', '<div style="font-size:0.78rem;color:var(--text2);padding:6px 0">No cash or ISA pots added.</div>');
    return;
  }

  const curAge = dobToAge(document.getElementById('current-dob').value) || 18;
  const endAge = +document.getElementById('end-age').value || 100;
  const retirementAge = +document.getElementById('retirement-age').value || 65;

  cashPotsData.forEach((pot, idx) => {
    const type = pot.type || 'cash';
    const isML = type === 'ss_isa' || type === 'lisa';
    const arrivesAge = pot.valueFromAge ?? curAge;
    const titleLabel = type === 'cash' ? 'Cash Pot' : type === 'cash_isa' ? 'Cash ISA' : type === 'ss_isa' ? 'S&S ISA' : 'LISA';
    const eq = pot.equityPct ?? 80;

    const rateField = isML
      ? `<div>
          <span class="field-label">Equity / Bond</span>
          <div style="display:flex;align-items:center;gap:6px">
            <input class="dyn-input" type="range" min="0" max="100" step="5"
              data-cash-pot-id="${pot.id}" data-field="equityPct"
              value="${eq}" style="flex:1">
            <span id="v-cash-equity-${pot.id}" style="font-size:0.78rem;min-width:46px;text-align:right">${eq}% / ${100 - eq}%</span>
          </div>
        </div>`
      : `<div>
          <span class="field-label">Interest rate</span>
          <div class="input-group">
            <input class="dyn-input" type="number" min="0" max="20" step="0.1"
              data-cash-pot-id="${pot.id}" data-field="interestPct"
              value="${pot.interestPct}" style="text-align:right">
            <span class="input-suffix">%</span>
          </div>
        </div>`;

    const lisaAgeWarn = (type === 'lisa' && retirementAge < 60)
      ? `<div style="font-size:0.72rem;color:#dc2626;margin-top:4px;padding:4px 6px;background:#fef2f2;border:1px solid #fca5a5;border-radius:3px">⚠ Your retirement age (${retirementAge}) is below 60 — LISA withdrawals before age 60 incur a 25% government penalty unless you are terminally ill or buying your first home.</div>`
      : '';
    const lisaNote = type === 'lisa'
      ? `<div style="font-size:0.72rem;color:var(--text2);margin-top:4px;padding:4px 6px;background:var(--surface2);border-radius:3px">25% govt bonus on contributions up to £4,000/yr (until age 50). Accessible penalty-free from age 60.</div>${lisaAgeWarn}`
      : '';

    const div = document.createElement('div');
    div.className = 'pot-card';
    div.innerHTML = `
      <div class="pot-card-header">
        <span class="pot-card-title" id="cash-pot-title-${pot.id}">${pot.name || (titleLabel + ' ' + (idx + 1))}</span>
        <button class="remove-btn" data-cash-pot-id="${pot.id}">✕</button>
      </div>
      <div style="margin-bottom:8px">
        <input class="dyn-input" type="text" placeholder="Name (optional)"
          data-cash-pot-id="${pot.id}" data-field="name"
          value="${(pot.name || '').replace(/"/g, '&quot;')}"
          style="font-size:0.8rem;color:var(--text2)">
      </div>
      <div class="inc-row" style="margin-bottom:8px">
        <label class="field-label" style="min-width:42px">Type</label>
        <select class="dyn-select" data-cash-pot-id="${pot.id}" data-field="type" style="flex:1">
          <option value="cash" ${type === 'cash' ? 'selected' : ''}>Regular Cash</option>
          <option value="cash_isa" ${type === 'cash_isa' ? 'selected' : ''}>Cash ISA</option>
          <option value="ss_isa" ${type === 'ss_isa' ? 'selected' : ''}>Stocks &amp; Shares ISA</option>
          <option value="lisa" ${type === 'lisa' ? 'selected' : ''}>LISA (Lifetime ISA)</option>
        </select>
      </div>
      <div class="two-col">
        <div>
          <span class="field-label">Value</span>
          <div class="input-group">
            <span class="input-prefix">£</span>
            <input class="dyn-input" type="number" min="0" step="1000" data-cash-pot-id="${pot.id}" data-field="value" value="${pot.value}">
          </div>
        </div>
        ${rateField}
      </div>
      <div class="two-col" id="contrib-row-${pot.id}" style="margin-top:6px;${pot.valueFromAge ? 'display:none' : ''}">
        <div>
          <span class="field-label">Monthly contribution</span>
          <div class="input-group">
            <span class="input-prefix">£</span>
            <input class="dyn-input" type="number" min="0" step="50" data-cash-pot-id="${pot.id}" data-field="monthlyContrib" value="${pot.monthlyContrib || 0}">
            <span class="input-suffix">/mo</span>
          </div>
        </div>
        <div>
          <span class="field-label">Contributions start</span>
          <input class="dyn-input" type="month" data-cash-pot-id="${pot.id}" data-field="contribStartMonth" value="${pot.contribStartMonth || new Date().toISOString().slice(0,7)}" style="width:100%;box-sizing:border-box">
        </div>
      </div>
      <div class="inc-row" style="margin-top:6px">
        <label><input type="checkbox" class="arrives-cb" data-cash-pot-id="${pot.id}" ${pot.valueFromAge ? 'checked' : ''}> Arrives at age</label>
        <div id="arrives-slider-${pot.id}" style="display:${pot.valueFromAge ? 'flex' : 'none'};align-items:center;gap:6px;margin-left:auto">
          <input type="range" class="dyn-input" min="${curAge}" max="${endAge}" step="1" value="${arrivesAge}" data-cash-pot-id="${pot.id}" data-field="valueFromAge" style="width:90px">
          <span id="arrives-val-${pot.id}" style="font-size:0.82rem;min-width:24px;text-align:right">${arrivesAge}</span>
        </div>
      </div>
      ${lisaNote}`;
    container.appendChild(div);
  });

  container.querySelectorAll('.remove-btn[data-cash-pot-id]').forEach(btn => {
    btn.addEventListener('click', () => removeCashPot(+btn.dataset.cashPotId));
  });

  container.querySelectorAll('.dyn-input[data-cash-pot-id], .dyn-select[data-cash-pot-id]').forEach(inp => {
    const evName = inp.tagName === 'SELECT' ? 'change' : 'input';
    inp.addEventListener(evName, () => {
      const potId = +inp.dataset.cashPotId;
      const field = inp.dataset.field;
      const pot = cashPotsData.find(p => p.id === potId);
      if (pot) {
        if (field === 'type') {
          pot.type = inp.value;
          const isML2 = inp.value === 'ss_isa' || inp.value === 'lisa';
          if (isML2) { pot.interestPct = 0; if (!pot.equityPct) pot.equityPct = 80; }
          else { if (!pot.interestPct) pot.interestPct = 3.5; }
          persistParams();
          renderCashPotsUI();
          return;
        }
        if (field === 'name') {
          pot.name = inp.value;
          const type2 = pot.type || 'cash';
          const lbl2 = type2 === 'cash' ? 'Cash Pot' : type2 === 'cash_isa' ? 'Cash ISA' : type2 === 'ss_isa' ? 'S&S ISA' : 'LISA';
          const titleEl = document.getElementById('cash-pot-title-' + potId);
          if (titleEl) titleEl.textContent = inp.value || (lbl2 + ' ' + (cashPotsData.indexOf(pot) + 1));
        } else if (field === 'contribStartMonth') {
          pot.contribStartMonth = inp.value;
        } else if (field === 'valueFromAge') {
          pot.valueFromAge = +inp.value;
          const valSpan = document.getElementById('arrives-val-' + potId);
          if (valSpan) valSpan.textContent = inp.value;
        } else if (field === 'equityPct') {
          pot.equityPct = +inp.value;
          const lbl = document.getElementById('v-cash-equity-' + potId);
          if (lbl) lbl.textContent = inp.value + '% / ' + (100 - +inp.value) + '%';
        } else {
          pot[field] = +inp.value;
        }
      }
      persistParams();
    });
  });

  container.querySelectorAll('.arrives-cb[data-cash-pot-id]').forEach(cb => {
    cb.addEventListener('change', () => {
      const pot = cashPotsData.find(p => p.id === +cb.dataset.cashPotId);
      if (!pot) return;
      const row = document.getElementById('arrives-slider-' + pot.id);
      const contribRow = document.getElementById('contrib-row-' + pot.id);
      if (cb.checked) {
        const defAge = +document.getElementById('retirement-age').value || 65;
        pot.valueFromAge = defAge;
        if (row) {
          row.style.display = 'flex';
          const slider = row.querySelector('input[type="range"]');
          const span = document.getElementById('arrives-val-' + pot.id);
          if (slider) slider.value = defAge;
          if (span) span.textContent = defAge;
        }
        if (contribRow) contribRow.style.display = 'none';
      } else {
        pot.valueFromAge = undefined;
        if (row) row.style.display = 'none';
        if (contribRow) contribRow.style.display = '';
      }
      persistParams();
    });
  });
}

// ── Partner dynamic data ──────────────────────────────────────────────────
let nextPartnerPotId = 1;
let partnerPotsData = [];
let nextPartnerCashPotId = 1;
let partnerCashPotsData = [];
let nextPartnerIncomeId = 1;
let partnerIncomesData = [];

function addPartnerPot(value, annualContrib, equityPct, name) {
  const id = nextPartnerPotId++;
  partnerPotsData.push({
    id,
    uuid: crypto.randomUUID(),
    name: name || '',
    value: (value !== undefined && value !== null) ? +value : 0,
    annualContrib: (annualContrib !== undefined && annualContrib !== null) ? +annualContrib : 0,
    equityPct: (equityPct !== undefined && equityPct !== null) ? +equityPct : 80,
    groupUuid: null,
    groupAllocationPct: null,
    archived: false,
    archivedDate: null,
    consolidatedIntoUuid: null,
  });
  renderPartnerPotsUI();
}

function removePartnerPot(id) {
  const _leaving = partnerPotsData.find(p => p.id === id);
  const _oldGroup = _leaving?.groupUuid;
  partnerPotsData = partnerPotsData.filter(p => p.id !== id);
  if (_oldGroup) dissolveIfSingleMember(_oldGroup, partnerPotsData, partnerGroupsData);
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
        <span class="pot-card-title" id="ppartner-pot-title-${pot.id}">${pot.name || ('Pot ' + (idx + 1))}${pot.archived ? ' <span class="archived-badge">Archived</span>' : ''}</span>
        <button class="remove-btn" data-ppartner-pot-id="${pot.id}" data-pot-set="partner" title="${isActualsEnabled() ? 'Archive / consolidate / delete' : 'Close pot'}">${isActualsEnabled() ? '⋯' : '✕'}</button>
      </div>
      <div style="margin-bottom:8px">
        <input class="dyn-input" type="text" placeholder="Name (optional, e.g. SIPP)"
          data-ppartner-pot-id="${pot.id}" data-field="name"
          value="${(pot.name || '').replace(/"/g, '&quot;')}"
          style="font-size:0.8rem;color:var(--text2)">
      </div>
      ${buildGroupRowHTML(pot, partnerGroupsData, 'ppartner-pot-id', 'pp-')}
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
    btn.addEventListener('click', () => {
      if (isActualsEnabled()) openPotModal(+btn.dataset.ppartnerPotId, 'partner');
      else quickClosePot(+btn.dataset.ppartnerPotId, 'partner');
    });
  });
  container.querySelectorAll('.dyn-input[data-ppartner-pot-id]').forEach(inp => {
    inp.addEventListener('input', () => {
      const pot = partnerPotsData.find(p => p.id === +inp.dataset.ppartnerPotId);
      if (pot) {
        if (inp.dataset.field === 'name') {
          pot.name = inp.value;
          const titleEl = document.getElementById('ppartner-pot-title-' + pot.id);
          if (titleEl) titleEl.textContent = inp.value || ('Pot ' + (partnerPotsData.indexOf(pot) + 1));
        } else {
          pot[inp.dataset.field] = +inp.value;
        }
      }
      if (inp.dataset.field === 'groupAllocationPct') validateGroupAllocations(partnerGroupsData, partnerPotsData, 'pp-');
      persistParams();
    });
  });

  // Wire group selects
  container.querySelectorAll('.pot-group-select[data-ppartner-pot-id]').forEach(sel => {
    sel.addEventListener('change', () => {
      const potId = +sel.dataset.ppartnerPotId;
      const pot = partnerPotsData.find(p => p.id === potId);
      if (!pot) return;
      if (sel.value === '__new__') {
        sel.value = pot.groupUuid || '';
        const row = document.getElementById('pp-group-create-' + potId);
        if (row) { row.style.display = 'flex'; document.getElementById('pp-group-create-input-' + potId)?.focus(); }
      } else {
        const oldGroup = pot.groupUuid;
        pot.groupUuid = sel.value || null;
        pot.groupAllocationPct = sel.value
          ? (partnerPotsData.filter(p => p.groupUuid === sel.value).length === 0 ? 100 : 0)
          : null;
        if (oldGroup && oldGroup !== sel.value) dissolveIfSingleMember(oldGroup, partnerPotsData, partnerGroupsData);
        validateGroupAllocations(partnerGroupsData, partnerPotsData, 'pp-');
        renderPartnerPotsUI();
        persistParams();
      }
    });
  });

  // Wire group create forms
  partnerPotsData.forEach(pot => {
    const row = document.getElementById('pp-group-create-' + pot.id);
    const input = document.getElementById('pp-group-create-input-' + pot.id);
    const addBtn = document.getElementById('pp-group-create-btn-' + pot.id);
    const cancelBtn = document.getElementById('pp-group-create-cancel-' + pot.id);
    const doCreate = () => {
      const name = input?.value.trim();
      if (!name) return;
      const newGroup = { uuid: crypto.randomUUID(), name };
      partnerGroupsData.push(newGroup);
      pot.groupUuid = newGroup.uuid;
      pot.groupAllocationPct = 100;
      renderPartnerPotsUI();
      persistParams();
    };
    addBtn?.addEventListener('click', doCreate);
    input?.addEventListener('keydown', e => { if (e.key === 'Enter') doCreate(); });
    cancelBtn?.addEventListener('click', () => { if (row) row.style.display = 'none'; });
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

  validateGroupAllocations(partnerGroupsData, partnerPotsData, 'pp-');
}

function addPartnerCashPot(value, interestPct, name, monthlyContrib, contribStartMonth, valueFromYear, type, equityPct) {
  const id = nextPartnerCashPotId++;
  const t = type || 'cash';
  const mktLinked = t === 'ss_isa' || t === 'lisa';
  partnerCashPotsData.push({
    id,
    uuid: crypto.randomUUID(),
    name: name || '',
    type: t,
    value: (value !== undefined && value !== null) ? +value : 0,
    interestPct: mktLinked ? 0 : (interestPct !== undefined && interestPct !== null ? +interestPct : 3.5),
    equityPct: mktLinked ? (equityPct !== undefined && equityPct !== null ? +equityPct : 80) : 80,
    monthlyContrib: (monthlyContrib !== undefined && monthlyContrib !== null) ? +monthlyContrib : 0,
    contribStartMonth: contribStartMonth || new Date().toISOString().slice(0, 7),
    valueFromAge: valueFromYear ? +valueFromYear : undefined,
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

  // ISA allowance warning
  const isaAnnual = partnerCashPotsData.filter(p => p.type && p.type !== 'cash').reduce((s, p) => s + (p.monthlyContrib || 0) * 12, 0);
  const lisaAnnual = partnerCashPotsData.filter(p => p.type === 'lisa').reduce((s, p) => s + (p.monthlyContrib || 0) * 12, 0);
  if (isaAnnual > 20000 || lisaAnnual > 4000) {
    const msg = isaAnnual > 20000
      ? `⚠ ISA contributions £${Math.round(isaAnnual).toLocaleString()}/yr exceed the £20,000 annual ISA allowance`
      : `⚠ LISA contributions £${Math.round(lisaAnnual).toLocaleString()}/yr exceed the £4,000 annual LISA limit`;
    const warn = document.createElement('div');
    warn.style.cssText = 'font-size:0.74rem;color:#dc2626;padding:5px 8px;background:#fef2f2;border:1px solid #fca5a5;border-radius:4px;margin-bottom:6px';
    warn.textContent = msg;
    container.appendChild(warn);
  }

  if (partnerCashPotsData.length === 0) {
    container.insertAdjacentHTML('beforeend', '<div style="font-size:0.78rem;color:var(--text2);padding:4px 0">No cash or ISA pots added.</div>');
    return;
  }

  const partnerCurAge = dobToAge(document.getElementById('partner-dob')?.value) || 18;
  const endAge = +document.getElementById('end-age').value || 100;
  const partnerRetAge = +document.getElementById('partner-retirement-age')?.value || 65;

  partnerCashPotsData.forEach((pot, idx) => {
    const type = pot.type || 'cash';
    const isML = type === 'ss_isa' || type === 'lisa';
    const arrivesAge = pot.valueFromAge ?? partnerCurAge;
    const titleLabel = type === 'cash' ? 'Cash Pot' : type === 'cash_isa' ? 'Cash ISA' : type === 'ss_isa' ? 'S&S ISA' : 'LISA';
    const eq = pot.equityPct ?? 80;

    const rateField = isML
      ? `<div>
          <span class="field-label">Equity / Bond</span>
          <div style="display:flex;align-items:center;gap:6px">
            <input class="dyn-input" type="range" min="0" max="100" step="5"
              data-ppartner-cash-id="${pot.id}" data-field="equityPct"
              value="${eq}" style="flex:1">
            <span id="v-pcash-equity-${pot.id}" style="font-size:0.78rem;min-width:46px;text-align:right">${eq}% / ${100 - eq}%</span>
          </div>
        </div>`
      : `<div>
          <span class="field-label">Interest rate</span>
          <div class="input-group">
            <input class="dyn-input" type="number" min="0" max="20" step="0.1"
              data-ppartner-cash-id="${pot.id}" data-field="interestPct"
              value="${pot.interestPct}" style="text-align:right">
            <span class="input-suffix">%</span>
          </div>
        </div>`;

    const lisaAgeWarn = (type === 'lisa' && partnerRetAge < 60)
      ? `<div style="font-size:0.72rem;color:#dc2626;margin-top:4px;padding:4px 6px;background:#fef2f2;border:1px solid #fca5a5;border-radius:3px">⚠ Partner's retirement age (${partnerRetAge}) is below 60 — LISA withdrawals before age 60 incur a 25% government penalty unless terminally ill or buying their first home.</div>`
      : '';
    const lisaNote = type === 'lisa'
      ? `<div style="font-size:0.72rem;color:var(--text2);margin-top:4px;padding:4px 6px;background:var(--surface2);border-radius:3px">25% govt bonus on contributions up to £4,000/yr (until age 50). Accessible penalty-free from age 60.</div>${lisaAgeWarn}`
      : '';

    const div = document.createElement('div');
    div.className = 'pot-card';
    div.innerHTML = `
      <div class="pot-card-header">
        <span class="pot-card-title" id="ppartner-cash-title-${pot.id}">${pot.name || (titleLabel + ' ' + (idx + 1))}</span>
        <button class="remove-btn" data-ppartner-cash-id="${pot.id}">✕</button>
      </div>
      <div style="margin-bottom:8px">
        <input class="dyn-input" type="text" placeholder="Name (optional)"
          data-ppartner-cash-id="${pot.id}" data-field="name"
          value="${(pot.name || '').replace(/"/g, '&quot;')}"
          style="font-size:0.8rem;color:var(--text2)">
      </div>
      <div class="inc-row" style="margin-bottom:8px">
        <label class="field-label" style="min-width:42px">Type</label>
        <select class="dyn-select" data-ppartner-cash-id="${pot.id}" data-field="type" style="flex:1">
          <option value="cash" ${type === 'cash' ? 'selected' : ''}>Regular Cash</option>
          <option value="cash_isa" ${type === 'cash_isa' ? 'selected' : ''}>Cash ISA</option>
          <option value="ss_isa" ${type === 'ss_isa' ? 'selected' : ''}>Stocks &amp; Shares ISA</option>
          <option value="lisa" ${type === 'lisa' ? 'selected' : ''}>LISA (Lifetime ISA)</option>
        </select>
      </div>
      <div class="two-col">
        <div>
          <span class="field-label">Value</span>
          <div class="input-group"><span class="input-prefix">£</span>
            <input class="dyn-input" type="number" min="0" step="1000" data-ppartner-cash-id="${pot.id}" data-field="value" value="${pot.value}">
          </div>
        </div>
        ${rateField}
      </div>
      <div class="two-col" id="pcontrib-row-${pot.id}" style="margin-top:6px;${pot.valueFromAge ? 'display:none' : ''}">
        <div>
          <span class="field-label">Monthly contribution</span>
          <div class="input-group">
            <span class="input-prefix">£</span>
            <input class="dyn-input" type="number" min="0" step="50" data-ppartner-cash-id="${pot.id}" data-field="monthlyContrib" value="${pot.monthlyContrib || 0}">
            <span class="input-suffix">/mo</span>
          </div>
        </div>
        <div>
          <span class="field-label">Contributions start</span>
          <input class="dyn-input" type="month" data-ppartner-cash-id="${pot.id}" data-field="contribStartMonth" value="${pot.contribStartMonth || new Date().toISOString().slice(0,7)}" style="width:100%;box-sizing:border-box">
        </div>
      </div>
      <div class="inc-row" style="margin-top:6px">
        <label><input type="checkbox" class="parrives-cb" data-ppartner-cash-id="${pot.id}" ${pot.valueFromAge ? 'checked' : ''}> Arrives at age</label>
        <div id="parrives-slider-${pot.id}" style="display:${pot.valueFromAge ? 'flex' : 'none'};align-items:center;gap:6px;margin-left:auto">
          <input type="range" class="dyn-input" min="${partnerCurAge}" max="${endAge}" step="1" value="${arrivesAge}" data-ppartner-cash-id="${pot.id}" data-field="valueFromAge" style="width:90px">
          <span id="parrives-val-${pot.id}" style="font-size:0.82rem;min-width:24px;text-align:right">${arrivesAge}</span>
        </div>
      </div>
      ${lisaNote}`;
    container.appendChild(div);
  });

  container.querySelectorAll('.remove-btn[data-ppartner-cash-id]').forEach(btn => {
    btn.addEventListener('click', () => removePartnerCashPot(+btn.dataset.ppartnerCashId));
  });

  container.querySelectorAll('.dyn-input[data-ppartner-cash-id], .dyn-select[data-ppartner-cash-id]').forEach(inp => {
    const evName = inp.tagName === 'SELECT' ? 'change' : 'input';
    inp.addEventListener(evName, () => {
      const pot = partnerCashPotsData.find(p => p.id === +inp.dataset.ppartnerCashId);
      if (pot) {
        const field = inp.dataset.field;
        if (field === 'type') {
          pot.type = inp.value;
          const isML2 = inp.value === 'ss_isa' || inp.value === 'lisa';
          if (isML2) { pot.interestPct = 0; if (!pot.equityPct) pot.equityPct = 80; }
          else { if (!pot.interestPct) pot.interestPct = 3.5; }
          persistParams();
          renderPartnerCashPotsUI();
          return;
        }
        if (field === 'name') {
          pot.name = inp.value;
          const type2 = pot.type || 'cash';
          const lbl2 = type2 === 'cash' ? 'Cash Pot' : type2 === 'cash_isa' ? 'Cash ISA' : type2 === 'ss_isa' ? 'S&S ISA' : 'LISA';
          const titleEl = document.getElementById('ppartner-cash-title-' + pot.id);
          if (titleEl) titleEl.textContent = inp.value || (lbl2 + ' ' + (partnerCashPotsData.indexOf(pot) + 1));
        } else if (field === 'contribStartMonth') {
          pot.contribStartMonth = inp.value;
        } else if (field === 'valueFromAge') {
          pot.valueFromAge = +inp.value;
          const valSpan = document.getElementById('parrives-val-' + pot.id);
          if (valSpan) valSpan.textContent = inp.value;
        } else if (field === 'equityPct') {
          pot.equityPct = +inp.value;
          const lbl = document.getElementById('v-pcash-equity-' + pot.id);
          if (lbl) lbl.textContent = inp.value + '% / ' + (100 - +inp.value) + '%';
        } else {
          pot[field] = +inp.value;
        }
      }
      persistParams();
    });
  });

  container.querySelectorAll('.parrives-cb[data-ppartner-cash-id]').forEach(cb => {
    cb.addEventListener('change', () => {
      const pot = partnerCashPotsData.find(p => p.id === +cb.dataset.ppartnerCashId);
      if (!pot) return;
      const row = document.getElementById('parrives-slider-' + pot.id);
      const pcontribRow = document.getElementById('pcontrib-row-' + pot.id);
      if (cb.checked) {
        const defAge = +document.getElementById('partner-retirement-age')?.value || 65;
        pot.valueFromAge = defAge;
        if (row) {
          row.style.display = 'flex';
          const slider = row.querySelector('input[type="range"]');
          const span = document.getElementById('parrives-val-' + pot.id);
          if (slider) slider.value = defAge;
          if (span) span.textContent = defAge;
        }
        if (pcontribRow) pcontribRow.style.display = 'none';
      } else {
        pot.valueFromAge = undefined;
        if (row) row.style.display = 'none';
        if (pcontribRow) pcontribRow.style.display = '';
      }
      persistParams();
    });
  });
}

function addPartnerIncome(name, amount, frequency, inflationLinked, incomePeriod = false, startAge = undefined, endAge = undefined, inflationBase = 'real', incomeType = 'employment') {
  const id = nextPartnerIncomeId++;
  partnerIncomesData.push({
    id,
    uuid: crypto.randomUUID(),
    name: name || 'Income source',
    amount: amount !== undefined ? amount : 0,
    frequency: frequency || 'annual',
    inflationLinked: inflationLinked === true,
    incomePeriod,
    startAge,
    endAge,
    inflationBase,
    incomeType,
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
  const partnerRetAge = +document.getElementById('partner-retirement-age')?.value || 65;
  const partnerCurAge = dobToAge(document.getElementById('partner-dob')?.value) || 18;
  partnerIncomesData.forEach(inc => {
    const div = document.createElement('div');
    div.className = 'income-card';
    const startVal = inc.startAge ?? '';
    const endVal = inc.endAge ?? '';
    const periodDisabled = inc.incomePeriod ? '' : 'disabled';
    const nominalLabel = inc.incomePeriod ? 'From Start Age' : 'From Retirement';
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
      <div class="inc-row">
        <label class="field-label" style="min-width:60px">Type</label>
        <select class="dyn-select" data-pinc-id="${inc.id}" data-field="incomeType">
          <option value="employment" ${(inc.incomeType || 'employment') === 'employment' ? 'selected' : ''}>Employment / Trading</option>
          <option value="property"   ${inc.incomeType === 'property'   ? 'selected' : ''}>Property / Rental</option>
          <option value="savings"    ${inc.incomeType === 'savings'    ? 'selected' : ''}>Savings / Interest</option>
          <option value="dividends"  ${inc.incomeType === 'dividends'  ? 'selected' : ''}>Dividends</option>
        </select>
      </div>
      <div class="inc-row">
        <label><input type="checkbox" data-pinc-id="${inc.id}" data-field="incomePeriod" ${inc.incomePeriod ? 'checked' : ''}> Period</label>
        <div class="inc-age-inputs">
          <label>From age <input type="number" class="inc-age-input" min="${partnerCurAge}" max="999" maxlength="3" data-pinc-id="${inc.id}" data-field="startAge" value="${startVal}" ${periodDisabled} placeholder="${partnerRetAge}"></label>
          <label>Until age <input type="number" class="inc-age-input" min="${partnerCurAge}" max="999" maxlength="3" data-pinc-id="${inc.id}" data-field="endAge" value="${endVal}" ${periodDisabled} placeholder="ever"></label>
        </div>
      </div>
      <div class="inc-row">
        <label><input type="checkbox" data-pinc-id="${inc.id}" data-field="inflationLinked" ${inc.inflationLinked ? 'checked' : ''}> Increases with inflation</label>
      </div>
      ${inc.inflationLinked ? `
      <div class="inc-row inc-infl-base">
        <label><input type="radio" name="pinflBase-${inc.id}" data-pinc-id="${inc.id}" data-field="inflationBase" value="real" ${inc.inflationBase !== 'nominal' ? 'checked' : ''}> From Today</label>
        <label><input type="radio" name="pinflBase-${inc.id}" data-pinc-id="${inc.id}" data-field="inflationBase" value="nominal" ${inc.inflationBase === 'nominal' ? 'checked' : ''}> ${nominalLabel}</label>
      </div>` : ''}`;
    container.appendChild(div);
  });
  container.querySelectorAll('.remove-btn[data-pinc-id]').forEach(btn => {
    btn.addEventListener('click', () => removePartnerIncome(+btn.dataset.pincId));
  });
  container.querySelectorAll('[data-pinc-id]').forEach(el => {
    const evName = (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'radio') ? 'change' : 'input';
    el.addEventListener(evName, () => {
      const inc = partnerIncomesData.find(i => i.id === +el.dataset.pincId);
      if (!inc) return;
      const field = el.dataset.field;
      if (field === 'incomePeriod') {
        inc.incomePeriod = el.checked;
        if (el.checked && !inc.startAge) {
          inc.startAge = +document.getElementById('partner-retirement-age')?.value || 65;
        }
        persistParams();
        renderPartnerIncomesUI();
        return;
      }
      if (field === 'inflationLinked') {
        inc.inflationLinked = el.checked;
        persistParams();
        renderPartnerIncomesUI();
        return;
      }
      if (field === 'inflationBase') {
        inc.inflationBase = el.value;
      } else if (field === 'name' || field === 'frequency' || field === 'incomeType') {
        inc[field] = el.value;
      } else if (field === 'startAge' || field === 'endAge') {
        if (el.value.length > 3) { el.value = el.value.slice(0, 3); }
        inc[field] = el.value !== '' ? +el.value : undefined;
      } else {
        inc[field] = +el.value;
      }
      persistParams();
    });
  });
  container.querySelectorAll('.inc-age-input[data-pinc-id]').forEach(el => {
    el.addEventListener('blur', () => {
      const inc = partnerIncomesData.find(i => i.id === +el.dataset.pincId);
      if (!inc) return;
      const field = el.dataset.field;
      const targetEndAge = +document.getElementById('end-age').value || 100;
      let changed = false;
      if (field === 'endAge' && inc.endAge !== undefined) {
        if (inc.endAge > targetEndAge) { inc.endAge = targetEndAge; changed = true; }
        if (inc.startAge !== undefined && inc.endAge <= inc.startAge) { inc.endAge = inc.startAge + 1; changed = true; }
        if (changed) el.value = inc.endAge;
      } else if (field === 'startAge' && inc.startAge !== undefined) {
        if (inc.startAge > targetEndAge) { inc.startAge = targetEndAge - 1; el.value = inc.startAge; changed = true; }
        if (inc.endAge !== undefined && inc.startAge >= inc.endAge) {
          inc.endAge = inc.startAge + 1;
          const endEl = container.querySelector(`.inc-age-input[data-pinc-id="${inc.id}"][data-field="endAge"]`);
          if (endEl) endEl.value = inc.endAge;
          changed = true;
        }
      }
      if (changed) persistParams();
    });
  });
}

// ── Partner DB Pension State ───────────────────────────────────────────────
let nextPartnerDbPensionId = 1;
let partnerDbPensionsData = [];

function addPartnerDbPension(name, startAge, preSpAnnual, postSpAnnual) {
  const id = nextPartnerDbPensionId++;
  partnerDbPensionsData.push({
    id,
    name: name || '',
    startAge: startAge !== undefined ? +startAge : undefined,
    preSpAnnual: preSpAnnual !== undefined ? +preSpAnnual : 0,
    postSpAnnual: postSpAnnual !== undefined ? +postSpAnnual : 0,
  });
  renderPartnerDbPensionsUI();
}

function removePartnerDbPension(id) {
  partnerDbPensionsData = partnerDbPensionsData.filter(d => d.id !== id);
  renderPartnerDbPensionsUI();
  persistParams();
}

function renderPartnerDbPensionsUI() {
  const container = document.getElementById('partner-db-pensions-container');
  if (!container) return;
  container.innerHTML = '';
  if (partnerDbPensionsData.length === 0) {
    container.innerHTML = '<div style="font-size:0.78rem;color:var(--text2);padding:4px 0">No DB pensions added.</div>';
    return;
  }
  const retAge = +document.getElementById('partner-retirement-age')?.value || 65;
  partnerDbPensionsData.forEach(db => {
    const div = document.createElement('div');
    div.className = 'income-card';
    div.innerHTML = `
      <div class="income-card-header">
        <div class="input-group" style="flex:1;margin-right:6px">
          <input class="dyn-input" type="text" placeholder="Scheme name" data-pdb-id="${db.id}" data-field="name" value="${(db.name || '').replace(/"/g,'&quot;')}" style="font-weight:600">
        </div>
        <button class="remove-btn" data-pdb-id="${db.id}">✕</button>
      </div>
      <div class="two-col">
        <div>
          <span class="field-label">Starts at age</span>
          <div class="input-group">
            <input class="dyn-input" type="number" min="50" max="90" step="1" data-pdb-id="${db.id}" data-field="startAge" value="${db.startAge ?? retAge}" placeholder="${retAge}">
          </div>
        </div>
        <div>
          <span class="field-label">Pre state pension age (£/yr)</span>
          <div class="input-group">
            <span class="input-prefix">£</span>
            <input class="dyn-input" type="number" min="0" step="100" data-pdb-id="${db.id}" data-field="preSpAnnual" value="${db.preSpAnnual}">
          </div>
        </div>
      </div>
      <div class="inc-row" style="margin-top:6px">
        <span class="field-label">Post state pension age (£/yr)</span>
        <div class="input-group" style="width:140px">
          <span class="input-prefix">£</span>
          <input class="dyn-input" type="number" min="0" step="100" data-pdb-id="${db.id}" data-field="postSpAnnual" value="${db.postSpAnnual}">
        </div>
      </div>
      <div style="font-size:0.72rem;color:var(--text2);margin-top:4px">Amounts in today's money. Taxed as employment income.</div>`;
    container.appendChild(div);
  });

  container.querySelectorAll('.remove-btn[data-pdb-id]').forEach(btn => {
    btn.addEventListener('click', () => removePartnerDbPension(+btn.dataset.pdbId));
  });
  container.querySelectorAll('[data-pdb-id]').forEach(el => {
    el.addEventListener('input', () => {
      const dbId = +el.dataset.pdbId;
      const field = el.dataset.field;
      const db = partnerDbPensionsData.find(d => d.id === dbId);
      if (!db) return;
      if (field === 'name') {
        db.name = el.value;
      } else {
        db[field] = el.value !== '' ? +el.value : undefined;
      }
      persistParams();
    });
  });
}

// ── Slider wiring ──────────────────────────────────────────────────────────
function dobToAge(dobStr) {
  if (!dobStr) return 0;
  return Math.floor((Date.now() - new Date(dobStr)) / (365.25 * 86400000));
}

function dobToAgeExact(dobStr) {
  if (!dobStr) return 0;
  return (Date.now() - new Date(dobStr)) / (365.25 * 86400000);
}

function getPartnerEnabled() {
  return document.getElementById('partner-enabled')?.checked || false;
}

function getPartnerParams() {
  if (!getPartnerEnabled()) return null;
  const partnerPclsEnabled = document.getElementById('partner-pcls-enabled')?.checked ?? false;
  return {
    currentAge: dobToAge(document.getElementById('partner-dob').value),
    currentAgeFrac: dobToAgeExact(document.getElementById('partner-dob').value),
    retirementAge: +document.getElementById('partner-retirement-age').value,
    spAge: +document.getElementById('partner-sp-age').value,
    sp: +document.getElementById('partner-sp').value,
    pots: partnerPotsData.map(p => Object.assign({}, p)),
    cashPots: partnerCashPotsData.map(p => Object.assign({}, p)),
    incomes: partnerIncomesData.map(i => Object.assign({}, i)),
    dbPensions: partnerDbPensionsData.map(d => Object.assign({}, d)),
    taxFreeMode: partnerPclsEnabled ? 'pcls' : 'ufpls',
    pclsPct: partnerPclsEnabled ? (+document.getElementById('partner-pcls-pct').value || 25) : 0,
  };
}

function getParams() {
  return {
    currentAge: dobToAge(document.getElementById('current-dob').value),
    currentAgeFrac: dobToAgeExact(document.getElementById('current-dob').value),
    retirementAge: +document.getElementById('retirement-age').value,
    endAge: +document.getElementById('end-age').value,
    spAge: +document.getElementById('sp-age').value,
    reductionEnabled: document.getElementById('income-reduction-enabled')?.checked !== false,
    reductionAge: document.getElementById('income-reduction-enabled')?.checked !== false ? +document.getElementById('reduction-age').value : 9999,
    reductionPct: document.getElementById('income-reduction-enabled')?.checked !== false ? +document.getElementById('reduction-pct').value : 0,
    drawdown: +document.getElementById('drawdown').value,
    sp: +document.getElementById('sp').value,
    inflation: +document.getElementById('inflation').value,
    returnPct: +document.getElementById('return-pct').value,
    runs: +document.getElementById('runs').value,
    guardrails: document.getElementById('guardrails').checked,
    alwaysTaxFree: document.getElementById('always-taxfree').checked,
    drawdownMode: document.querySelector('input[name="drawdown-mode"]:checked')?.value || 'amount',
    drawdownPct: +document.getElementById('drawdown-pct').value,
    drawdownInflation: document.getElementById('drawdown-inflation').checked,
    annuityEnabled: document.getElementById('annuity-enabled')?.checked ?? false,
    annuityAge: +document.getElementById('annuity-age')?.value || 75,
    annuityPremium: +document.getElementById('annuity-premium')?.value || 0,
    annuityIncome: +document.getElementById('annuity-income')?.value || 0,
    spendingGoals: spendingGoalsData.map(g => Object.assign({}, g)),
    pots: potsData.map(p => Object.assign({}, p)),
    incomes: incomesData.map(i => Object.assign({}, i)),
    dbPensions: dbPensionsData.map(d => Object.assign({}, d)),
    cashPots: cashPotsData.map(p => Object.assign({}, p)),
    partner: getPartnerParams(),
    taxFreeMode: document.getElementById('pcls-enabled')?.checked ? 'pcls' : 'ufpls',
    pclsPct: document.getElementById('pcls-enabled')?.checked ? (+document.getElementById('pcls-pct').value || 25) : 0,
  };
}

function sanitizeParams() {
  const retire = document.getElementById('retirement-age');
  const end = document.getElementById('end-age');
  if (!retire || !end) return;
  let retirementAge = +retire.value;
  let endAge = +end.value;

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
  document.body.classList.toggle('today-prices-active', checked);
  document.querySelectorAll('.today-money-toggle').forEach(cb => { cb.checked = checked; });
  if (r) {
    renderCards(r);
    // re-render current active view immediately
    const tab = document.querySelector('.tab.active')?.dataset.tab || 'pot';
    if (tab === 'pot') { renderPotChart(r); renderAccumulationCards(r); }
    else if (tab === 'taxbreakdown') renderTaxBreakdown(r);
    else if (tab === 'realincome') renderRealIncomeChart(r);
    else if (tab === 'netmonthly') { renderNetMonthlyChart(r); renderIncomeTable(r); }
    else if (tab === 'annualincome') { renderAnnualIncomeChart(r); renderAnnualIncomeTable(r); }
    else if (tab === 'montecarlo') { renderMonteCarloChart(r); renderMonteCarloTable(r, +document.getElementById('mc-pctile').value); renderSurvivalChart(r); }
    else if (tab === 'historicalreplay') renderHistoricalReplayTab(r);
  }
}

const sliders = [
  ['retirement-age', v => v, ''],
  ['end-age', v => v, ''], ['sp-age', v => v, ''],
  ['reduction-age', v => v, ''], ['reduction-pct', v => fmtPct(v), ''],
  ['drawdown', v => fmtGBP(v), ''], ['drawdown-pct', v => fmtPct(+v, 2), ''],
  ['sp', v => fmtGBP(v), ''], ['inflation', v => fmtPct(v), ''],
  ['return-pct', v => fmtPct(+v, 1), ''],
  ['runs', v => fmt(v), ''],
];
const partnerSliders = [
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

// Keep end-age min in sync with retirement-age
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
const ACTUALS_KEY = 'pension-forecast-actuals-v1';
const APP_VERSION = '1.0.0';
const SLIDER_IDS = sliders.map(([id]) => id);

// ── Actuals ledger ─────────────────────────────────────────────────────────
// Events stored in localStorage under ACTUALS_KEY, separate from settings.
// Event shape: { id, type, potUuid|incomeUuid, date, amount, notes, linkedEventId }
let actualsEvents = [];   // full event log

function loadActuals() {
  try {
    const raw = localStorage.getItem(ACTUALS_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      actualsEvents = Array.isArray(obj.events) ? obj.events : [];
    }
  } catch(e) { actualsEvents = []; }
}

function saveActuals() {
  try {
    localStorage.setItem(ACTUALS_KEY, JSON.stringify({ version: 1, events: actualsEvents }));
  } catch(e) {}
}

function addActualEvent(event) {
  actualsEvents.push({ id: crypto.randomUUID(), ...event });
  saveActuals();
}

// ── Export / Import ────────────────────────────────────────────────────────
function buildExportPayload() {
  // Settings = projection assumptions only (not pot values/contributions, not income amounts)
  const settings = {};
  SLIDER_IDS.forEach(id => { settings[id] = document.getElementById(id)?.value; });
  settings['guardrails']          = document.getElementById('guardrails')?.checked;
  settings['always-taxfree']       = document.getElementById('always-taxfree')?.checked ? '1' : '0';
  settings['drawdown-mode']       = document.querySelector('input[name="drawdown-mode"]:checked')?.value || 'amount';
  settings['drawdown-inflation']  = document.getElementById('drawdown-inflation')?.checked;
  settings['partner-enabled']     = getPartnerEnabled();
  settings['current-dob']         = document.getElementById('current-dob')?.value || '';
  settings['partner-dob']         = document.getElementById('partner-dob')?.value || '';
  settings['today-money']         = isTodayMoney() ? '1' : '0';
  settings['actuals-enabled']     = isActualsEnabled() ? '1' : '0';
  settings['recalibrate-toggle']  = document.getElementById('recalibrate-toggle')?.checked ? '1' : '0';
  settings['pcls-enabled']         = document.getElementById('pcls-enabled')?.checked ? '1' : '0';
  settings['pcls-pct']             = document.getElementById('pcls-pct')?.value || '25';
  settings['partner-pcls-enabled']       = document.getElementById('partner-pcls-enabled')?.checked ? '1' : '0';
  settings['partner-pcls-pct']           = document.getElementById('partner-pcls-pct')?.value || '25';
  settings['income-reduction-enabled']   = document.getElementById('income-reduction-enabled')?.checked ? '1' : '0';
  settings['sorr-enabled']               = document.getElementById('sorr-enabled')?.checked ? '1' : '0';
  settings['sorr-crash-pct']             = document.getElementById('sorr-crash-pct')?.value ?? '-25';
  settings['sorr-crash-years']           = document.getElementById('sorr-crash-years')?.value ?? '3';
  settings['sorr-table-open']            = document.getElementById('sorr-table-wrap')?.classList.contains('hidden') ? '0' : '1';
  partnerSliders.forEach(([id]) => { const el = document.getElementById(id); if (el) settings[id] = el.value; });

  // Actuals = all pot registries, income registries, groups, events
  const actuals = {
    potRegistry:            potsData.map(p => ({ ...p })),
    cashPotRegistry:        cashPotsData.map(p => ({ ...p })),
    partnerPotRegistry:     partnerPotsData.map(p => ({ ...p })),
    partnerCashPotRegistry: partnerCashPotsData.map(p => ({ ...p })),
    incomeRegistry:         incomesData.map(i => ({ ...i })),
    partnerIncomeRegistry:  partnerIncomesData.map(i => ({ ...i })),
    dbPensionRegistry:      dbPensionsData.map(d => ({ ...d })),
    partnerDbPensionRegistry: partnerDbPensionsData.map(d => ({ ...d })),
    groups:                 groupsData.map(g => ({ ...g })),
    partnerGroups:          partnerGroupsData.map(g => ({ ...g })),
    events:                 actualsEvents.map(e => ({ ...e })),
  };

  return {
    exportedAt:  new Date().toISOString(),
    appVersion:  APP_VERSION,
    actuals,
    settings,
  };
}

function exportBackup() {
  const payload = buildExportPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `pension-forecast-backup-${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  // Record export date for backup-age badge
  try { localStorage.setItem('pension-forecast-last-export', new Date().toISOString()); } catch(e) {}
  updateBackupBadge();
}

function importBackup(payload, mode) {
  // mode: 'actuals' = restore actuals+registries only; 'full' = also restore settings
  if (!payload || typeof payload !== 'object') return false;

  const actuals = payload.actuals;
  if (!actuals) return false;

  // Restore pot registries
  if (Array.isArray(actuals.potRegistry) && actuals.potRegistry.length > 0) {
    potsData = [];
    actuals.potRegistry.forEach(p => {
      const id = nextPotId++;
      potsData.push({
        id,
        uuid: p.uuid || crypto.randomUUID(),
        name: p.name || '',
        value: +p.value || 0,
        annualContrib: +p.annualContrib || 0,
        equityPct: p.equityPct !== undefined ? +p.equityPct : 80,
        groupUuid: p.groupUuid || null,
        groupAllocationPct: p.groupAllocationPct != null ? +p.groupAllocationPct : null,
        archived: p.archived === true,
        archivedDate: p.archivedDate || null,
        consolidatedIntoUuid: p.consolidatedIntoUuid || null,
      });
    });
    renderPotsUI();
  }
  if (Array.isArray(actuals.cashPotRegistry)) {
    cashPotsData = [];
    actuals.cashPotRegistry.forEach(p => {
      const id = nextCashPotId++;
      cashPotsData.push({ id, uuid: p.uuid || crypto.randomUUID(), name: p.name || '', type: p.type || 'cash', value: +p.value || 0, interestPct: p.interestPct !== undefined ? +p.interestPct : 3.5, equityPct: p.equityPct !== undefined ? +p.equityPct : 80, monthlyContrib: +p.monthlyContrib || 0, contribStartMonth: p.contribStartMonth || new Date().toISOString().slice(0, 7), valueFromAge: p.valueFromAge ? +p.valueFromAge : undefined });
    });
    renderCashPotsUI();
  }
  if (Array.isArray(actuals.partnerPotRegistry) && actuals.partnerPotRegistry.length > 0) {
    partnerPotsData = [];
    actuals.partnerPotRegistry.forEach(p => {
      const id = nextPartnerPotId++;
      partnerPotsData.push({
        id,
        uuid: p.uuid || crypto.randomUUID(),
        name: p.name || '',
        value: +p.value || 0,
        annualContrib: +p.annualContrib || 0,
        equityPct: p.equityPct !== undefined ? +p.equityPct : 80,
        groupUuid: p.groupUuid || null,
        groupAllocationPct: p.groupAllocationPct != null ? +p.groupAllocationPct : null,
        archived: p.archived === true,
        archivedDate: p.archivedDate || null,
        consolidatedIntoUuid: p.consolidatedIntoUuid || null,
      });
    });
    renderPartnerPotsUI();
  }
  if (Array.isArray(actuals.partnerCashPotRegistry)) {
    partnerCashPotsData = [];
    actuals.partnerCashPotRegistry.forEach(p => {
      const id = nextPartnerCashPotId++;
      partnerCashPotsData.push({ id, uuid: p.uuid || crypto.randomUUID(), name: p.name || '', type: p.type || 'cash', value: +p.value || 0, interestPct: p.interestPct !== undefined ? +p.interestPct : 3.5, equityPct: p.equityPct !== undefined ? +p.equityPct : 80, monthlyContrib: +p.monthlyContrib || 0, contribStartMonth: p.contribStartMonth || new Date().toISOString().slice(0, 7), valueFromAge: p.valueFromAge ? +p.valueFromAge : undefined });
    });
    renderPartnerCashPotsUI();
  }
  if (Array.isArray(actuals.incomeRegistry)) {
    incomesData = [];
    actuals.incomeRegistry.forEach(inc => {
      const id = nextIncomeId++;
      incomesData.push({ id, uuid: inc.uuid || crypto.randomUUID(), name: inc.name || 'Income source', amount: inc.amount || 0, frequency: inc.frequency || 'annual', inflationLinked: inc.inflationLinked === true, incomePeriod: inc.incomePeriod === true, startAge: inc.startAge || undefined, endAge: inc.endAge || undefined, inflationBase: inc.inflationBase === 'nominal' ? 'nominal' : 'real', incomeType: inc.incomeType || 'employment' });
    });
    renderIncomesUI();
  }
  if (Array.isArray(actuals.partnerIncomeRegistry)) {
    partnerIncomesData = [];
    actuals.partnerIncomeRegistry.forEach(inc => {
      const id = nextPartnerIncomeId++;
      partnerIncomesData.push({ id, uuid: inc.uuid || crypto.randomUUID(), name: inc.name || 'Income source', amount: inc.amount || 0, frequency: inc.frequency || 'annual', inflationLinked: inc.inflationLinked === true, incomePeriod: inc.incomePeriod === true, startAge: inc.startAge || undefined, endAge: inc.endAge || undefined, inflationBase: inc.inflationBase === 'nominal' ? 'nominal' : 'real', incomeType: inc.incomeType || 'employment' });
    });
    renderPartnerIncomesUI();
  }
  if (Array.isArray(actuals.dbPensionRegistry)) {
    dbPensionsData = [];
    actuals.dbPensionRegistry.forEach(db => {
      const id = nextDbPensionId++;
      dbPensionsData.push({ id, name: db.name || '', startAge: db.startAge !== undefined ? +db.startAge : undefined, preSpAnnual: +db.preSpAnnual || 0, postSpAnnual: +db.postSpAnnual || 0 });
    });
    renderDbPensionsUI();
  }
  if (Array.isArray(actuals.partnerDbPensionRegistry)) {
    partnerDbPensionsData = [];
    actuals.partnerDbPensionRegistry.forEach(db => {
      const id = nextPartnerDbPensionId++;
      partnerDbPensionsData.push({ id, name: db.name || '', startAge: db.startAge !== undefined ? +db.startAge : undefined, preSpAnnual: +db.preSpAnnual || 0, postSpAnnual: +db.postSpAnnual || 0 });
    });
    renderPartnerDbPensionsUI();
  }
  if (Array.isArray(actuals.groups))        groupsData = actuals.groups.filter(g => g.uuid && g.name);
  if (Array.isArray(actuals.partnerGroups)) partnerGroupsData = actuals.partnerGroups.filter(g => g.uuid && g.name);

  // Idempotent merge of events by id
  if (Array.isArray(actuals.events)) {
    const existingIds = new Set(actualsEvents.map(e => e.id));
    actuals.events.forEach(e => { if (e.id && !existingIds.has(e.id)) actualsEvents.push(e); });
    saveActuals();
  }

  if (mode === 'full' && payload.settings) {
    restoreParams(payload.settings);
  }

  persistParams();
  return true;
}

function updateBackupBadge() {
  const badge = document.getElementById('backup-age-badge');
  if (!badge) return;
  let lastExport = null;
  try { lastExport = localStorage.getItem('pension-forecast-last-export'); } catch(e) {}
  if (!lastExport) {
    badge.textContent = 'Never exported';
    badge.className = 'backup-badge backup-badge--amber';
    badge.style.display = '';
    return;
  }
  const days = Math.floor((Date.now() - new Date(lastExport).getTime()) / 86400000);
  if (days < 30) { badge.style.display = 'none'; return; }
  badge.textContent = days >= 90 ? `Backup ${days}d ago — overdue` : `Backup ${days}d ago`;
  badge.className   = `backup-badge ${days >= 90 ? 'backup-badge--red' : 'backup-badge--amber'}`;
  badge.style.display = '';
}

function initImportDialog() {
  const fileInput = document.getElementById('import-file-input');
  const dialog    = document.getElementById('import-confirm-dialog');
  const btnActuals = document.getElementById('import-actuals-btn');
  const btnFull    = document.getElementById('import-full-btn');
  const btnCancel  = document.getElementById('import-cancel-btn');
  const fullWarn   = document.getElementById('import-full-warning');
  let _pendingPayload = null;

  document.getElementById('import-backup-btn').addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      try {
        _pendingPayload = JSON.parse(e.target.result);
        if (!_pendingPayload?.actuals) { alert('Invalid backup file.'); _pendingPayload = null; return; }
        // Show full-restore warning only if settings block is present
        if (fullWarn) fullWarn.style.display = _pendingPayload.settings ? '' : 'none';
        if (btnFull)  btnFull.style.display   = _pendingPayload.settings ? '' : 'none';
        dialog.classList.remove('hidden');
      } catch { alert('Could not read backup file.'); }
      fileInput.value = '';
    };
    reader.readAsText(file);
  });

  btnActuals?.addEventListener('click', () => {
    if (_pendingPayload && importBackup(_pendingPayload, 'actuals')) {
      dialog.classList.add('hidden'); _pendingPayload = null;
    }
  });
  btnFull?.addEventListener('click', () => {
    if (_pendingPayload && importBackup(_pendingPayload, 'full')) {
      dialog.classList.add('hidden'); _pendingPayload = null;
    }
  });
  btnCancel?.addEventListener('click', () => {
    dialog.classList.add('hidden'); _pendingPayload = null;
  });
  dialog?.addEventListener('click', e => { if (e.target === dialog) { dialog.classList.add('hidden'); _pendingPayload = null; } });
}

// ── Actuals Journal form ───────────────────────────────────────────────────
const JOURNAL_TYPE_META = {
  pot_valuation:  { icon: '📊', label: 'Pension Pot Actual' },
  cash_valuation: { icon: '💰', label: 'Cash Pot Actual' },
  income_actual:  { icon: '📥', label: 'Other Income Actual' },
};

function _potDisplayName(pot, idx, prefix) {
  return (pot.name || `${prefix} Pot ${idx + 1}`) + (pot.archived ? ' (archived)' : '');
}
function _incomeDisplayName(inc, idx, prefix) {
  return inc.name || `${prefix} Income ${idx + 1}`;
}
function _cashDisplayName(cp, idx, prefix) {
  return cp.name || `${prefix} Cash Pot ${idx + 1}`;
}

function populateJournalTargets() {
  const type   = document.getElementById('journal-type').value;
  const sel    = document.getElementById('journal-target');
  const partner = document.getElementById('partner-enabled')?.checked;
  sel.innerHTML = '';

  const addGroup = (label, items) => {
    if (!items.length) return;
    const grp = document.createElement('optgroup');
    grp.label = label;
    items.forEach(([uuid, text]) => {
      const opt = new Option(text, uuid);
      grp.appendChild(opt);
    });
    sel.appendChild(grp);
  };

  if (type === 'pot_valuation') {
    addGroup('Your groups', groupsData.map(g => ['group:' + g.uuid, '≡ ' + g.name]));
    addGroup('Your pots',   potsData.map((p, i) => [p.uuid, _potDisplayName(p, i, 'Your')]));
    if (partner) addGroup('Partner groups', partnerGroupsData.map(g => ['group:' + g.uuid, '≡ ' + g.name]));
    if (partner) addGroup('Partner pots',   partnerPotsData.map((p, i) => [p.uuid, _potDisplayName(p, i, "Partner's")]));
  } else if (type === 'cash_valuation') {
    addGroup('Your cash',    cashPotsData.map((p, i) => [p.uuid, _cashDisplayName(p, i, 'Your')]));
    if (partner) addGroup('Partner cash', partnerCashPotsData.map((p, i) => [p.uuid, _cashDisplayName(p, i, "Partner's")]));
  } else if (type === 'income_actual') {
    addGroup('Your income',    incomesData.map((inc, i) => [inc.uuid, _incomeDisplayName(inc, i, 'Your')]));
    if (partner) addGroup('Partner income', partnerIncomesData.map((inc, i) => [inc.uuid, _incomeDisplayName(inc, i, "Partner's")]));
  }

  if (!sel.options.length) {
    sel.appendChild(new Option('— no targets available —', ''));
  }
}

function renderJournalRecent() {
  const section    = document.getElementById('journal-recent');
  const list       = document.getElementById('journal-list');
  const countEl    = document.getElementById('journal-count');
  const total      = actualsEvents.length;
  if (!total) { section.style.display = 'none'; return; }
  section.style.display = '';
  countEl.textContent   = `${total} total`;
  const recent = [...actualsEvents].reverse().slice(0, 8);
  list.innerHTML = recent.map(e => {
    const meta   = JOURNAL_TYPE_META[e.type] || { icon: '📝', label: e.type };
    const amount = e.amount != null ? `£${Number(e.amount).toLocaleString('en-GB')}` : '';
    const note   = e.notes ? ` · ${e.notes}` : '';
    const name   = e.targetName || e.targetUuid?.slice(0, 8) || '—';
    return `<div class="journal-entry">
      <span class="journal-entry-icon">${meta.icon}</span>
      <div class="journal-entry-body">
        <div class="journal-entry-title">${name}</div>
        <div class="journal-entry-meta">${e.date || ''} · ${meta.label} · ${amount}${note}</div>
      </div>
      <button class="journal-entry-del" data-event-id="${e.id}" title="Delete entry">×</button>
    </div>`;
  }).join('');

  list.querySelectorAll('.journal-entry-del').forEach(btn => {
    btn.addEventListener('click', () => {
      actualsEvents = actualsEvents.filter(ev => ev.id !== btn.dataset.eventId);
      saveActuals();
      renderJournalRecent();
    });
  });
}

function initJournalForm() {
  const typeEl   = document.getElementById('journal-type');
  const dateEl   = document.getElementById('journal-date');
  const amountEl = document.getElementById('journal-amount');
  const notesEl  = document.getElementById('journal-notes');
  const addBtn   = document.getElementById('journal-add-btn');
  const feedback = document.getElementById('journal-feedback');
  let _fbTimer   = null;

  // Default date = today
  dateEl.value = new Date().toISOString().slice(0, 10);

  // Rebuild target dropdown on type change, and also when the user opens the target select
  // (so it always reflects the latest added/removed pots without patching all render fns)
  typeEl.addEventListener('change', populateJournalTargets);
  document.getElementById('journal-target').addEventListener('mousedown', populateJournalTargets);
  populateJournalTargets();

  addBtn.addEventListener('click', () => {
    const type      = typeEl.value;
    const targetSel = document.getElementById('journal-target');
    const targetUuid = targetSel.value;
    const date      = dateEl.value;
    const amount    = parseFloat(amountEl.value);

    if (!targetUuid) { alert('Please select a target.'); return; }
    if (!date)       { alert('Please enter a date.'); return; }
    if (isNaN(amount) || amount < 0) { alert('Please enter a valid amount.'); return; }

    const notes = notesEl.value.trim() || null;

    if (targetUuid.startsWith('group:')) {
      // Fan out: one event per pot in the group, proportional to groupAllocationPct
      const groupUuid = targetUuid.slice(6);
      const groupLabel = targetSel.options[targetSel.selectedIndex]?.text.replace(/^≡\s*/, '') || groupUuid;
      // Determine which pots array this group belongs to
      const isPartnerGroup = partnerGroupsData.some(g => g.uuid === groupUuid);
      const srcPots = (isPartnerGroup ? partnerPotsData : potsData).filter(p => p.groupUuid === groupUuid);
      if (!srcPots.length) { alert('No pots are assigned to this group.'); return; }

      // Compute weights: use groupAllocationPct if set and sum > 0, else equal split
      const totalPct = srcPots.reduce((s, p) => s + (p.groupAllocationPct || 0), 0);
      const useEqual = totalPct === 0;
      const batchId  = crypto.randomUUID(); // link events so they can be managed together

      srcPots.forEach(pot => {
        const weight = useEqual ? (1 / srcPots.length) : (pot.groupAllocationPct || 0) / totalPct;
        const alloc  = Math.round(amount * weight * 100) / 100;
        addActualEvent({
          type,
          targetUuid: pot.uuid,
          targetName: pot.name || groupLabel,
          date,
          amount: alloc,
          notes: notes ? `${notes} (via ${groupLabel})` : `via ${groupLabel}`,
          groupBatchId: batchId,
        });
      });
    } else {
      // Single target
      const allTargets = [
        ...potsData, ...partnerPotsData,
        ...cashPotsData, ...partnerCashPotsData,
        ...incomesData, ...partnerIncomesData,
      ];
      const match = allTargets.find(x => x.uuid === targetUuid);
      const targetName = match?.name || targetSel.options[targetSel.selectedIndex]?.text || targetUuid;

      addActualEvent({
        type,
        targetUuid,
        targetName,
        date,
        amount,
        notes,
      });
    }

    renderJournalRecent();
    // Reset form (keep type and date so rapid logging is easy)
    amountEl.value = '';
    notesEl.value  = '';

    clearTimeout(_fbTimer);
    feedback.style.display = '';
    _fbTimer = setTimeout(() => { feedback.style.display = 'none'; }, 2500);
  });
}

function persistParams() {
  const obj = {};
  SLIDER_IDS.forEach(id => { obj[id] = document.getElementById(id).value; });
  const _cdob = document.getElementById('current-dob'); if (_cdob) obj['current-dob'] = _cdob.value;
  const _pdob = document.getElementById('partner-dob'); if (_pdob) obj['partner-dob'] = _pdob.value;
  obj['guardrails'] = document.getElementById('guardrails').checked ? '1' : '0';
  obj['always-taxfree'] = document.getElementById('always-taxfree').checked ? '1' : '0';
  obj['today-money'] = isTodayMoney() ? '1' : '0';
  obj['drawdown-mode'] = document.querySelector('input[name="drawdown-mode"]:checked')?.value || 'amount';
  obj['drawdown-inflation'] = document.getElementById('drawdown-inflation').checked ? '1' : '0';
  obj['pots'] = JSON.stringify(potsData);
  obj['groups'] = JSON.stringify(groupsData);
  obj['incomes'] = JSON.stringify(incomesData);
  obj['cashPots'] = JSON.stringify(cashPotsData);
  obj['partner-enabled'] = getPartnerEnabled() ? '1' : '0';
  partnerSliders.forEach(([id]) => { const el = document.getElementById(id); if (el) obj[id] = el.value; });
  obj['partner-pots'] = JSON.stringify(partnerPotsData);
  obj['partner-groups'] = JSON.stringify(partnerGroupsData);
  obj['partner-cashPots'] = JSON.stringify(partnerCashPotsData);
  obj['partner-incomes'] = JSON.stringify(partnerIncomesData);
  obj['db-pensions'] = JSON.stringify(dbPensionsData);
  obj['partner-db-pensions'] = JSON.stringify(partnerDbPensionsData);
  obj['actuals-enabled'] = isActualsEnabled() ? '1' : '0';
  obj['recalibrate-toggle'] = document.getElementById('recalibrate-toggle')?.checked ? '1' : '0';
  obj['income-reduction-enabled'] = document.getElementById('income-reduction-enabled')?.checked ? '1' : '0';
  obj['pcls-enabled'] = document.getElementById('pcls-enabled')?.checked ? '1' : '0';
  obj['pcls-pct'] = document.getElementById('pcls-pct')?.value || '25';
  obj['partner-pcls-enabled'] = document.getElementById('partner-pcls-enabled')?.checked ? '1' : '0';
  obj['partner-pcls-pct'] = document.getElementById('partner-pcls-pct')?.value || '25';
  obj['sorr-enabled'] = document.getElementById('sorr-enabled')?.checked ? '1' : '0';
  obj['sorr-crash-pct'] = document.getElementById('sorr-crash-pct')?.value ?? '-25';
  obj['sorr-crash-years'] = document.getElementById('sorr-crash-years')?.value ?? '3';
  obj['sorr-table-open'] = document.getElementById('sorr-table-wrap')?.classList.contains('hidden') ? '0' : '1';
  obj['annuity-enabled'] = document.getElementById('annuity-enabled')?.checked ? '1' : '0';
  obj['annuity-age'] = document.getElementById('annuity-age')?.value || '75';
  obj['annuity-premium'] = document.getElementById('annuity-premium')?.value || '0';
  obj['annuity-income'] = document.getElementById('annuity-income')?.value || '0';
  obj['spending-goals'] = JSON.stringify(spendingGoalsData);
  obj['active-tab'] = document.querySelector('.tab.active')?.dataset.tab || 'pot';
  obj['mc-pctile'] = document.getElementById('mc-pctile').value;
  const taxYearEl = document.getElementById('tax-year-select');
  if (taxYearEl) obj['tax-year-select'] = taxYearEl.value;
  const hrYearEl = document.getElementById('hist-replay-year');
  if (hrYearEl && hrYearEl.value) obj['hist-replay-year'] = hrYearEl.value;
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
            ['pots','groups','incomes','cashPots','partner-pots','partner-groups','partner-cashPots','partner-incomes'].forEach(k => {
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
  if (obj['always-taxfree'] !== undefined) {
    document.getElementById('always-taxfree').checked = obj['always-taxfree'] !== '0';
  }
  if (obj['drawdown-mode']) {
    const modeEl = document.getElementById('dm-' + obj['drawdown-mode']);
    if (modeEl) { modeEl.checked = true; updateDrawdownMode(obj['drawdown-mode']); }
  }
  if (obj['drawdown-inflation'] !== undefined) {
    document.getElementById('drawdown-inflation').checked = obj['drawdown-inflation'] !== '0';
  }
  if (obj['income-reduction-enabled'] !== undefined) {
    const reductionEnabled = obj['income-reduction-enabled'] !== '0';
    const reductionCb = document.getElementById('income-reduction-enabled');
    if (reductionCb) {
      reductionCb.checked = reductionEnabled;
      const slidersDiv = document.getElementById('income-reduction-sliders');
      if (slidersDiv) slidersDiv.style.display = reductionEnabled ? '' : 'none';
    }
  }
  if (obj['today-money'] !== undefined) {
    const checked = obj['today-money'] !== '0';
    setTodayMoney(checked, null);
  }
  // Restore pots
  if (obj['groups']) {
    try {
      const saved = JSON.parse(obj['groups']);
      if (Array.isArray(saved)) groupsData = saved.filter(g => g.uuid && g.name);
    } catch(e) {}
  }
  if (obj['pots']) {
    try {
      const saved = JSON.parse(obj['pots']);
      if (Array.isArray(saved) && saved.length > 0) {
        potsData = [];
        saved.forEach(p => {
          const id = nextPotId++;
          potsData.push({
            id,
            uuid: p.uuid || crypto.randomUUID(),
            name: p.name || '',
            value: +p.value || 0,
            annualContrib: +p.annualContrib || 0,
            equityPct: p.equityPct !== undefined ? +p.equityPct : 80,
            glideEnabled: p.glideEnabled === true,
            glideTargetPct: p.glideTargetPct !== undefined ? +p.glideTargetPct : 40,
            glideTargetAge: p.glideTargetAge !== undefined ? +p.glideTargetAge : 75,
            groupUuid: p.groupUuid || null,
            groupAllocationPct: p.groupAllocationPct != null ? +p.groupAllocationPct : null,
            archived: p.archived === true,
            archivedDate: p.archivedDate || null,
            consolidatedIntoUuid: p.consolidatedIntoUuid || null,
          });
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
          incomesData.push({
            id,
            uuid: inc.uuid || crypto.randomUUID(),
            name: inc.name || 'Income source',
            amount: inc.amount || 0,
            frequency: inc.frequency || 'annual',
            inflationLinked: inc.inflationLinked === true,
            incomePeriod: inc.incomePeriod === true,
            startAge: inc.startAge || undefined,
            endAge: inc.endAge || undefined,
            inflationBase: inc.inflationBase === 'nominal' ? 'nominal' : 'real',
            incomeType: inc.incomeType || 'employment',
          });
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
          cashPotsData.push({
            id,
            uuid: p.uuid || crypto.randomUUID(),
            name: p.name || '',
            type: p.type || 'cash',
            value: +p.value || 0,
            interestPct: p.interestPct !== undefined ? +p.interestPct : 3.5,
            equityPct: p.equityPct !== undefined ? +p.equityPct : 80,
            monthlyContrib: +p.monthlyContrib || 0,
            contribStartMonth: p.contribStartMonth || new Date().toISOString().slice(0, 7),
            valueFromAge: p.valueFromAge ? +p.valueFromAge : undefined,
          });
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
  if (obj['partner-groups']) {
    try {
      const saved = JSON.parse(obj['partner-groups']);
      if (Array.isArray(saved)) partnerGroupsData = saved.filter(g => g.uuid && g.name);
    } catch(e) {}
  }
  if (obj['partner-pots']) {
    try {
      const saved = JSON.parse(obj['partner-pots']);
      if (Array.isArray(saved) && saved.length > 0) {
        partnerPotsData = [];
        saved.forEach(p => {
          const id = nextPartnerPotId++;
          partnerPotsData.push({
            id,
            uuid: p.uuid || crypto.randomUUID(),
            name: p.name || '',
            value: +p.value || 0,
            annualContrib: +p.annualContrib || 0,
            equityPct: p.equityPct !== undefined ? +p.equityPct : 80,
            groupUuid: p.groupUuid || null,
            groupAllocationPct: p.groupAllocationPct != null ? +p.groupAllocationPct : null,
            archived: p.archived === true,
            archivedDate: p.archivedDate || null,
            consolidatedIntoUuid: p.consolidatedIntoUuid || null,
          });
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
          partnerCashPotsData.push({
            id,
            uuid: p.uuid || crypto.randomUUID(),
            name: p.name || '',
            type: p.type || 'cash',
            value: +p.value || 0,
            interestPct: p.interestPct !== undefined ? +p.interestPct : 3.5,
            equityPct: p.equityPct !== undefined ? +p.equityPct : 80,
            monthlyContrib: +p.monthlyContrib || 0,
            contribStartMonth: p.contribStartMonth || new Date().toISOString().slice(0, 7),
            valueFromAge: p.valueFromAge ? +p.valueFromAge : undefined,
          });
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
          partnerIncomesData.push({
            id,
            uuid: inc.uuid || crypto.randomUUID(),
            name: inc.name || 'Income source',
            amount: inc.amount || 0,
            frequency: inc.frequency || 'annual',
            inflationLinked: inc.inflationLinked === true,
            incomePeriod: inc.incomePeriod === true,
            startAge: inc.startAge || undefined,
            endAge: inc.endAge || undefined,
            inflationBase: inc.inflationBase === 'nominal' ? 'nominal' : 'real',
            incomeType: inc.incomeType || 'employment',
          });
        });
        renderPartnerIncomesUI();
      }
    } catch(e) {}
  }
  if (obj['db-pensions']) {
    try {
      const saved = JSON.parse(obj['db-pensions']);
      if (Array.isArray(saved)) {
        dbPensionsData = [];
        saved.forEach(db => {
          const id = nextDbPensionId++;
          dbPensionsData.push({
            id,
            name: db.name || '',
            startAge: db.startAge !== undefined ? +db.startAge : undefined,
            preSpAnnual: +db.preSpAnnual || 0,
            postSpAnnual: +db.postSpAnnual || 0,
          });
        });
        renderDbPensionsUI();
      }
    } catch(e) {}
  }
  if (obj['partner-db-pensions']) {
    try {
      const saved = JSON.parse(obj['partner-db-pensions']);
      if (Array.isArray(saved)) {
        partnerDbPensionsData = [];
        saved.forEach(db => {
          const id = nextPartnerDbPensionId++;
          partnerDbPensionsData.push({
            id,
            name: db.name || '',
            startAge: db.startAge !== undefined ? +db.startAge : undefined,
            preSpAnnual: +db.preSpAnnual || 0,
            postSpAnnual: +db.postSpAnnual || 0,
          });
        });
        renderPartnerDbPensionsUI();
      }
    } catch(e) {}
  }
  if (obj['actuals-enabled'] !== undefined) {
    const enabled = obj['actuals-enabled'] !== '0';
    const cb = document.getElementById('actuals-enabled');
    if (cb) cb.checked = enabled;
    applyActualsEnabled(enabled);
  }
  // Restore annuity settings
  if (obj['annuity-enabled'] !== undefined) {
    const cb = document.getElementById('annuity-enabled');
    if (cb) {
      cb.checked = obj['annuity-enabled'] !== '0';
      const fields = document.getElementById('annuity-fields');
      if (fields) fields.classList.toggle('hidden', !cb.checked);
    }
  }
  if (obj['annuity-age'] !== undefined) {
    const el = document.getElementById('annuity-age');
    const lbl = document.getElementById('v-annuity-age');
    if (el) { el.value = obj['annuity-age']; if (lbl) lbl.textContent = obj['annuity-age']; }
  }
  if (obj['annuity-premium'] !== undefined) {
    const el = document.getElementById('annuity-premium');
    if (el) el.value = obj['annuity-premium'];
  }
  if (obj['annuity-income'] !== undefined) {
    const el = document.getElementById('annuity-income');
    if (el) el.value = obj['annuity-income'];
  }
  // Restore spending goals
  if (obj['spending-goals']) {
    try {
      const saved = JSON.parse(obj['spending-goals']);
      if (Array.isArray(saved)) {
        spendingGoalsData = [];
        saved.forEach(g => {
          spendingGoalsData.push({ id: nextGoalId++, label: g.label || '', startAge: +g.startAge || 65, endAge: +g.endAge || 70, extraAnnual: +g.extraAnnual || 0 });
        });
        renderSpendingGoalsUI();
      }
    } catch(e) {}
  }
  if (obj['recalibrate-toggle'] !== undefined) {
    const cb = document.getElementById('recalibrate-toggle');
    if (cb) cb.checked = obj['recalibrate-toggle'] !== '0';
  }
  if (obj['pcls-enabled'] !== undefined) {
    const cb = document.getElementById('pcls-enabled');
    if (cb) { cb.checked = obj['pcls-enabled'] !== '0' && obj['pcls-enabled'] !== ''; updateTfMode('primary'); }
  }
  if (obj['pcls-pct'] !== undefined) {
    const el = document.getElementById('pcls-pct');
    const lbl = document.getElementById('v-pcls-pct');
    if (el) { el.value = obj['pcls-pct']; if (lbl) lbl.textContent = obj['pcls-pct'] + '%'; }
  }
  if (obj['partner-pcls-enabled'] !== undefined) {
    const cb = document.getElementById('partner-pcls-enabled');
    if (cb) { cb.checked = obj['partner-pcls-enabled'] !== '0' && obj['partner-pcls-enabled'] !== ''; updateTfMode('partner'); }
  }
  if (obj['partner-pcls-pct'] !== undefined) {
    const el = document.getElementById('partner-pcls-pct');
    const lbl = document.getElementById('v-partner-pcls-pct');
    if (el) { el.value = obj['partner-pcls-pct']; if (lbl) lbl.textContent = obj['partner-pcls-pct'] + '%'; }
  }
  // Restore UI view state
  if (obj['active-tab']) setActiveTab(obj['active-tab']);
  if (obj['mc-pctile'] !== undefined) {
    const el = document.getElementById('mc-pctile');
    const lbl = document.getElementById('v-mc-pctile');
    if (el) { el.value = obj['mc-pctile']; if (lbl) lbl.textContent = MC_PCT_LABELS[+obj['mc-pctile']]; }
  }
  if (obj['tax-year-select'] !== undefined) {
    const el = document.getElementById('tax-year-select');
    if (el) el.value = obj['tax-year-select'];
  }
  if (obj['hist-replay-year'] !== undefined) {
    const el = document.getElementById('hist-replay-year');
    if (el && el.querySelector(`option[value="${obj['hist-replay-year']}"]`)) el.value = obj['hist-replay-year'];
  }
  // Restore DOB inputs (with migration from old integer current-age saves)
  {
    const el = document.getElementById('current-dob');
    const lbl = document.getElementById('v-current-age');
    if (obj['current-dob'] && el) {
      el.value = obj['current-dob'];
      if (el._flatpickr) el._flatpickr.setDate(obj['current-dob'], false);
      if (lbl) lbl.textContent = 'Age ' + dobToAge(obj['current-dob']);
    } else if (obj['current-age'] && el) {
      const age = +obj['current-age'];
      const dob = new Date(Date.now() - age * 365.25 * 86400000).toISOString().slice(0, 10);
      el.value = dob;
      if (el._flatpickr) el._flatpickr.setDate(dob, false);
      if (lbl) lbl.textContent = 'Age ' + age;
    }
  }
  {
    const el = document.getElementById('partner-dob');
    const lbl = document.getElementById('v-partner-age');
    if (obj['partner-dob'] && el) {
      el.value = obj['partner-dob'];
      if (el._flatpickr) el._flatpickr.setDate(obj['partner-dob'], false);
      if (lbl) lbl.textContent = 'Age ' + dobToAge(obj['partner-dob']);
    } else if (obj['partner-age'] && el) {
      const age = +obj['partner-age'];
      const dob = new Date(Date.now() - age * 365.25 * 86400000).toISOString().slice(0, 10);
      el.value = dob;
      if (el._flatpickr) el._flatpickr.setDate(dob, false);
      if (lbl) lbl.textContent = 'Age ' + age;
    }
  }
  // Sequence of Returns Risk
  if (obj['sorr-enabled'] !== undefined) {
    const cb = document.getElementById('sorr-enabled');
    const controls = document.getElementById('sorr-controls');
    if (cb) {
      cb.checked = obj['sorr-enabled'] !== '0';
      if (controls) controls.classList.toggle('hidden', !cb.checked);
    }
  }
  if (obj['sorr-crash-pct'] !== undefined) {
    const el = document.getElementById('sorr-crash-pct');
    const lbl = document.getElementById('v-sorr-crash-pct');
    if (el) { el.value = obj['sorr-crash-pct']; if (lbl) lbl.textContent = obj['sorr-crash-pct'] + '%'; }
  }
  if (obj['sorr-crash-years'] !== undefined) {
    const el = document.getElementById('sorr-crash-years');
    const lbl = document.getElementById('v-sorr-crash-years');
    if (el) {
      el.value = obj['sorr-crash-years'];
      if (lbl) lbl.textContent = obj['sorr-crash-years'] + (+obj['sorr-crash-years'] === 1 ? ' year' : ' years');
    }
  }
  if (obj['sorr-table-open'] !== undefined) {
    const wrap = document.getElementById('sorr-table-wrap');
    const btn = document.getElementById('sorr-table-toggle');
    const open = obj['sorr-table-open'] !== '0';
    if (wrap) wrap.classList.toggle('hidden', !open);
    if (btn) btn.textContent = open ? 'Hide year-by-year' : 'Show year-by-year';
  }
}

// ── Drawdown mode UI toggle ────────────────────────────────────────────────
function updateDrawdownMode(mode) {
  document.getElementById('drawdown-amount-row').classList.toggle('hidden', mode !== 'amount');
  document.getElementById('drawdown-pct-row').classList.toggle('hidden', mode !== 'pct');
}

function updateTfMode(person) {
  const prefix = person === 'partner' ? 'partner-' : '';
  const enabled = document.getElementById(`${prefix}pcls-enabled`)?.checked ?? false;
  const pclsRow = document.getElementById(`${prefix}pcls-pct-row`);
  if (pclsRow) pclsRow.classList.toggle('hidden', !enabled);
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
  const yearsToRetirement = Math.max(0, p.retirementAge - (p.currentAgeFrac ?? p.currentAge));
  const currentYear = new Date().getFullYear();
  const startPensionPot = r.startPensionPot || r.startPot;
  const partnerPotBalance = 0;
  const partnerCashBalance = 0;

  const cashBals = r.startCashPotVals ? Float64Array.from(r.startCashPotVals) : new Float64Array(0);
  // Build combined pot list and draw order for cash pots
  const _aidAllCashPots = [...(p.cashPots || []), ...(p.partner?.cashPots || [])];
  const _aidCashDrawOrder = Array.from({ length: cashBals.length }, (_, ci) => {
    const t = (_aidAllCashPots[ci]?.type) || 'cash';
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
    const partner = p.partner;
    const partnerAge = partner ? partner.currentAge + (age - p.currentAge) : null;
    const hasPartnerSP = !!(partner && partnerAge >= partner.spAge);
    const partnerSpInflated = hasPartnerSP ? partner.sp * ci : 0;

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
    const partnerRetiredAID = !!(partner && partnerAge >= partner.retirementAge);
    const partnerOtherAID = (partner?.incomes?.length && partnerRetiredAID)
      ? calcOtherIncomesNet(partner.incomes, ciFromNow, { currentAge: partnerAge, retirementAge: partner.retirementAge, yearsToRetirement: Math.max(0, partner.retirementAge - (partner.currentAgeFrac ?? partner.currentAge)), baseInflFactor }) : { grossTotal: 0, taxTotal: 0, netTotal: 0 };
    // Reduction applies to total gross income (drawdown target + other incomes combined).
    // Only the drawdown target can be cut; other incomes are fixed. Floor at 0.
    const inflFactor = p.drawdownInflation ? ci : 1.0;
    const baseTarget = p.drawdown * inflFactor;
    const totalOtherGross = otherNet.grossTotal + partnerOtherAID.grossTotal;
    const targetNominal = age >= p.reductionAge
      ? Math.max(0, (baseTarget + totalOtherGross) * (1 - p.reductionPct / 100) - totalOtherGross)
      : baseTarget;
    const neededFromPots = Math.max(0, targetNominal - spInflated - partnerSpInflated);

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
    for (const _ci2 of _aidCashDrawOrder) {
      if (cashContrib >= _atfCashTarget) break;
      if ((_aidAllCashPots[_ci2]?.type || 'cash') === 'lisa' && age < 60) continue;
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
    // PCLS: pot is already reduced at retirement, all subsequent drawdown is fully taxable
    const actualPriDraw = potWithdrawNominal * primaryPotFrac_;
    const actualParDraw = potWithdrawNominal * (1 - primaryPotFrac_);
    const priMode = p.taxFreeMode || 'ufpls';
    const parMode = p.partner?.taxFreeMode || 'ufpls';
    let primaryTFracYear;
    if (priMode === 'none' || priMode === 'pcls') {
      primaryTFracYear = 0;
    } else {
      primaryTFracYear = actualPriDraw > 0
        ? Math.min(0.25, Math.max(0, LSA - cumulPrimaryTaxFree) / actualPriDraw)
        : (cumulPrimaryTaxFree < LSA ? 0.25 : 0);
    }
    let partnerTFracYear;
    if (parMode === 'none' || parMode === 'pcls') {
      partnerTFracYear = 0;
    } else {
      partnerTFracYear = (partner && actualParDraw > 0)
        ? Math.min(0.25, Math.max(0, LSA - cumulPartnerTaxFree) / actualParDraw)
        : 0.25;
    }
    const taxFreeFracYear = potWithdrawNominal > 0
      ? (actualPriDraw * primaryTFracYear + actualParDraw * partnerTFracYear) / potWithdrawNominal
      : 0.25;
    const tc = calcPensionTax(potWithdrawNominal, spInflated, hasStatePension, taxFreeFracYear, otherNet.byType, currentYear + (age - p.currentAge));
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
      cashInterestAnn: cashInterestNom,
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

// ── Recalibration engine ───────────────────────────────────────────────────
// Applies the most recent actuals journal entries to a params object,
// returning a new params with pot values, cash pot values, and income amounts
// replaced by the latest logged actuals. Also advances currentAge to the
// as-of date so the simulation projects from actual present state.
//
// Called with a deep-cloned params so the original (UI) state is never mutated.
function applyActualsRecalibration(p, events) {
  if (!events || events.length === 0) return p;
  const calYear = new Date().getFullYear();

  // ── Helper: latest event per targetUuid for a given type ────────────────
  function latestByUuid(type) {
    const map = {};
    events
      .filter(e => e.type === type && e.date && e.targetUuid && e.amount != null)
      .forEach(e => {
        const prev = map[e.targetUuid];
        if (!prev || e.date > prev.date) map[e.targetUuid] = e;
      });
    return map;
  }

  const latestPotVals    = latestByUuid('pot_valuation');
  const latestCashVals   = latestByUuid('cash_valuation');
  const latestIncomeVals = latestByUuid('income_actual');

  // ── Find as-of year: the most recent date across all used actuals ────────
  const allUsed = [
    ...Object.values(latestPotVals),
    ...Object.values(latestCashVals),
    ...Object.values(latestIncomeVals),
  ];
  if (allUsed.length === 0) return p;

  const asOfYear = Math.max(...allUsed.map(e => new Date(e.date).getFullYear()));
  const ageDelta = asOfYear - calYear;       // years between most recent journal entry and today
  const newCurrentAge = p.currentAge + ageDelta;

  // Can't recalibrate beyond end age
  if (newCurrentAge >= p.endAge) return p;

  // Deep clone so we never mutate the live params
  const rp = JSON.parse(JSON.stringify(p));
  rp.currentAge = Math.max(rp.currentAge, newCurrentAge);

  // ── Pension pots ─────────────────────────────────────────────────────────
  // When multiple pot_valuation events share the same targetUuid but come from a
  // group fan-out in the same year, they've already been summed per-pot.
  // latestByUuid gives the single most-recent event per pot uuid.
  rp.pots = rp.pots.map(pot => {
    const ev = latestPotVals[pot.uuid];
    if (!ev) return pot;
    return {
      ...pot,
      value: Number(ev.amount),
      // Zero contributions for the years already elapsed up to as-of date
      // (the logged value already includes them)
      annualContrib: pot.annualContrib,
    };
  });

  // ── Cash pots ─────────────────────────────────────────────────────────────
  rp.cashPots = rp.cashPots.map(cp => {
    const ev = latestCashVals[cp.uuid];
    if (!ev) return cp;
    return { ...cp, value: Number(ev.amount) };
  });

  // ── Partner pots ──────────────────────────────────────────────────────────
  if (rp.partner) {
    rp.partner.pots = (rp.partner.pots || []).map(pot => {
      const ev = latestPotVals[pot.uuid];
      if (!ev) return pot;
      return { ...pot, value: Number(ev.amount) };
    });
    rp.partner.cashPots = (rp.partner.cashPots || []).map(cp => {
      const ev = latestCashVals[cp.uuid];
      if (!ev) return cp;
      return { ...cp, value: Number(ev.amount) };
    });
  }

  // ── Other incomes ─────────────────────────────────────────────────────────
  // income_actual amount = gross annual income for the year logged.
  // Replace the income source's amount so the forward projection uses it.
  rp.incomes = rp.incomes.map(inc => {
    const ev = latestIncomeVals[inc.uuid];
    if (!ev) return inc;
    // Normalise to annual regardless of income frequency setting
    const annualAmount = inc.frequency === 'monthly'
      ? Number(ev.amount)   // event already logged as annual gross
      : Number(ev.amount);
    return { ...inc, amount: annualAmount };
  });
  if (rp.partner) {
    rp.partner.incomes = (rp.partner.incomes || []).map(inc => {
      const ev = latestIncomeVals[inc.uuid];
      if (!ev) return inc;
      return { ...inc, amount: Number(ev.amount) };
    });
  }

  return rp;
}

function isRecalibrationEnabled() {
  return isActualsEnabled() && document.getElementById('recalibrate-toggle')?.checked && actualsEvents.length > 0;
}

function isActualsEnabled() {
  return document.getElementById('actuals-enabled')?.checked ?? false;
}

function applyActualsEnabled(enabled) {
  // Actuals Journal hidden (feature incomplete) — keep tab and section hidden regardless
  document.getElementById('journal-body')?.classList.toggle('hidden', !enabled);
  const tabBtn = document.querySelector('.tab[data-tab="actuals"]');
  if (tabBtn) {
    tabBtn.style.display = 'none'; // always hidden
    // If currently on actuals tab and disabling, switch to pot
    if (!enabled && tabBtn.classList.contains('active')) {
      setActiveTab('pot');
    }
  }
  // Update pot buttons in-place (avoids full DOM rebuild / scroll reset on mobile)
  document.querySelectorAll('.remove-btn[data-pot-id]').forEach(btn => {
    btn.textContent = enabled ? '⋯' : '✕';
    btn.title = enabled ? 'Archive / consolidate / delete' : 'Close pot';
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', () => {
      if (isActualsEnabled()) openPotModal(+newBtn.dataset.potId, 'user');
      else quickClosePot(+newBtn.dataset.potId, 'user');
    });
  });
  document.querySelectorAll('.remove-btn[data-ppartner-pot-id]').forEach(btn => {
    btn.textContent = enabled ? '⋯' : '✕';
    btn.title = enabled ? 'Archive / consolidate / delete' : 'Close pot';
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', () => {
      if (isActualsEnabled()) openPotModal(+newBtn.dataset.ppartnerPotId, 'partner');
      else quickClosePot(+newBtn.dataset.ppartnerPotId, 'partner');
    });
  });
}

function runSimulation() {
  sanitizeParams();
  const base = getParams();
  const p = isRecalibrationEnabled() ? applyActualsRecalibration(base, actualsEvents) : base;
  const r = runSimulationImpl(p);
  if (r) r._recalibrated = isRecalibrationEnabled();
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

  // Use deterministic pot at retirement for all cards except probability of success
  const useToday = isTodayMoney();
  const baseInflFactor = 1 + (r.p.inflation || 0) / 100;
  const yearsToRet = Math.max(0, r.p.retirementAge - (r.p.currentAgeFrac ?? r.p.currentAge));
  const realDeflRet = Math.pow(1 / baseInflFactor, yearsToRet);
  const detPension    = r.detPotByYear?.[0] ?? 0;
  const detCash       = r.detCashBalByYear?.[0] ?? 0;
  const detRetPot     = detPension + detCash;
  const detPensionDisp = useToday ? detPension * realDeflRet : detPension;
  const detCashDisp    = useToday ? detCash * realDeflRet    : detCash;
  // PCLS £ equivalent next to slider
  const primaryPclsDisp = useToday ? (r.primaryPclsAmt || 0) * realDeflRet : (r.primaryPclsAmt || 0);
  const partnerPclsDisp = useToday ? (r.partnerPclsAmt || 0) * realDeflRet : (r.partnerPclsAmt || 0);
  const pclsGbpEl = document.getElementById('pcls-gbp-equiv');
  if (pclsGbpEl) pclsGbpEl.textContent = (r.primaryPclsAmt || 0) > 0 ? `≈ ${fmtGBP(primaryPclsDisp)} lump sum` : '';
  const partnerPclsGbpEl = document.getElementById('partner-pcls-gbp-equiv');
  if (partnerPclsGbpEl) partnerPclsGbpEl.textContent = (r.partnerPclsAmt || 0) > 0 ? `≈ ${fmtGBP(partnerPclsDisp)} lump sum` : '';

  document.getElementById('c-median').textContent = fmtGBP(detPensionDisp);
  const cMedianSub = document.getElementById('c-median-sub');
  if (cMedianSub) {
    const pclsLine = (r.primaryPclsAmt || 0) + (r.partnerPclsAmt || 0) > 0
      ? `<span style="display:block;font-size:0.72rem;color:var(--text2);margin-top:3px">After PCLS deduction of <strong style="color:var(--text)">${fmtGBP(primaryPclsDisp + partnerPclsDisp)}</strong></span>`
      : '';
    const cashLine = detCashDisp > 0
      ? `<span style="display:block;font-size:0.72rem;color:var(--text2);margin-top:3px">Cash/ISA: <strong style="color:var(--text)">${fmtGBP(detCashDisp)}</strong></span>`
      : '';
    cMedianSub.innerHTML = `${useToday ? "today's money" : 'nominal at retirement'}${pclsLine}${cashLine}`;
  }

  // SWR: keep the MC-derived absolute safe amount (r.swr) but express as % of det pot
  const detSwrPct = detRetPot > 0 ? (r.swr / detRetPot) * 100 : 0;
  const swrEl = document.getElementById('c-swr');
  swrEl.textContent = fmtPct(detSwrPct);
  swrEl.className = 'card-value ' + (detSwrPct >= 4 ? 'green' : detSwrPct >= 3 ? 'amber' : 'red');

  const actualRatePct = r.p.drawdownMode === 'pct'
    ? (r.p.drawdownPct ?? 0)
    : (detRetPot > 0 ? (r.p.drawdown / detRetPot) * 100 : 0);
  const actualEl = document.getElementById('c-actual-rate');
  actualEl.textContent = fmtPct(actualRatePct);
  actualEl.className = actualRatePct <= detSwrPct ? 'green' : actualRatePct <= detSwrPct * 1.2 ? 'amber' : 'red';

  const aid0 = r.annualIncomeData?.[0];
  const cardNetMonthly   = aid0 ? (useToday ? aid0.netReal      : aid0.netNom)           : r.netMonthly;
  const cardGrossMonthly = aid0 ? (useToday ? aid0.netGrossReal  : aid0.netGrossNom)      : r.grossMonthly;
  const cardNetAnnual    = aid0 ? (useToday ? aid0.netReal * 12  : aid0.netNom * 12)      : r.netAnnual;
  const cardGrossAnnual  = aid0 ? (useToday ? aid0.netGrossReal * 12 : aid0.netGrossNom * 12) : r.grossAnnual;
  document.getElementById('c-monthly').textContent = fmtGBP(cardNetMonthly, 0);
  const cMonthlySub = document.getElementById('c-monthly-sub');
  if (cMonthlySub) {
    cMonthlySub.innerHTML = `at retirement (after tax)<br>
      <span style="display:block;font-size:0.72rem;color:var(--text2)">Gross monthly: <strong style="color:var(--text)">${fmtGBP(cardGrossMonthly, 0)}</strong></span>
      <span style="display:block;font-size:0.72rem;color:var(--text2)">Net annual: <strong style="color:var(--text)">${fmtGBP(cardNetAnnual, 0)}</strong></span>
      <span style="display:block;font-size:0.72rem;color:var(--text2)">Gross annual: <strong style="color:var(--text)">${fmtGBP(cardGrossAnnual, 0)}</strong></span>`;
  }

  const lsaAlert = document.getElementById('lsa-alert');
  lsaAlert.classList.toggle('hidden', r.startPot <= FORMER_LTA);

  // Show save-baseline button and re-render comparison if one exists
  const saveBtn = document.getElementById('save-baseline-btn');
  if (saveBtn) saveBtn.style.display = '';
  if (baselineSnapshot) renderComparisonPanel(r);
}

// ── Spending Goals ─────────────────────────────────────────────────────────
function addSpendingGoal(label, startAge, endAge, extraAnnual) {
  const retAge = +document.getElementById('retirement-age')?.value || 65;
  spendingGoalsData.push({
    id: nextGoalId++,
    label: label || '',
    startAge: startAge !== undefined ? +startAge : retAge,
    endAge: endAge !== undefined ? +endAge : retAge + 5,
    extraAnnual: extraAnnual !== undefined ? +extraAnnual : 5000,
  });
}

function renderSpendingGoalsUI() {
  const container = document.getElementById('spending-goals-container');
  if (!container) return;
  if (spendingGoalsData.length === 0) {
    container.innerHTML = '<div style="font-size:0.78rem;color:var(--text2);padding:4px 0">No goals added yet.</div>';
    return;
  }
  container.innerHTML = spendingGoalsData.map(g => `
    <div class="pot-card" style="margin-bottom:8px" data-goal-id="${g.id}">
      <div class="pot-card-header">
        <input class="dyn-input goal-label" type="text" placeholder="Label (e.g. World cruise)" value="${(g.label || '').replace(/"/g,'&quot;')}" data-goal-id="${g.id}" style="font-size:0.82rem;font-weight:600;flex:1;min-width:0">
        <button class="remove-btn goal-remove-btn" data-goal-id="${g.id}">✕</button>
      </div>
      <div class="two-col" style="margin-top:6px">
        <div>
          <span class="field-label">From age</span>
          <input class="dyn-input goal-field" type="number" min="18" max="100" value="${g.startAge}" data-goal-id="${g.id}" data-field="startAge" style="width:70px">
        </div>
        <div>
          <span class="field-label">To age</span>
          <input class="dyn-input goal-field" type="number" min="18" max="100" value="${g.endAge}" data-goal-id="${g.id}" data-field="endAge" style="width:70px">
        </div>
        <div>
          <span class="field-label">Extra £/yr</span>
          <div class="input-group" style="width:110px"><span class="input-prefix">£</span>
          <input class="dyn-input goal-field" type="number" min="0" step="500" value="${g.extraAnnual}" data-goal-id="${g.id}" data-field="extraAnnual"></div>
        </div>
      </div>
    </div>`).join('');

  container.querySelectorAll('.goal-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      spendingGoalsData = spendingGoalsData.filter(g => g.id !== +btn.dataset.goalId);
      renderSpendingGoalsUI();
      persistParams();
    });
  });
  container.querySelectorAll('.goal-label').forEach(inp => {
    inp.addEventListener('input', () => {
      const g = spendingGoalsData.find(g => g.id === +inp.dataset.goalId);
      if (g) g.label = inp.value;
      persistParams();
    });
  });
  container.querySelectorAll('.goal-field').forEach(inp => {
    inp.addEventListener('input', () => {
      const g = spendingGoalsData.find(g => g.id === +inp.dataset.goalId);
      if (g) g[inp.dataset.field] = +inp.value;
      persistParams();
    });
  });
}

// ── Scenario Comparison ────────────────────────────────────────────────────
function saveBaseline(r) {
  const useToday = isTodayMoney();
  const baseInflFactor = 1 + (r.p.inflation || 0) / 100;
  const yearsToRet = Math.max(0, r.p.retirementAge - (r.p.currentAgeFrac ?? r.p.currentAge));
  const realDeflRet = Math.pow(1 / baseInflFactor, yearsToRet);
  const detPension = r.detPotByYear?.[0] ?? 0;
  const detCash = r.detCashBalByYear?.[0] ?? 0;
  const detRetPot = detPension + detCash;
  const aid0 = r.annualIncomeData?.[0];
  baselineSnapshot = {
    prob: r.prob,
    potAtRet: useToday ? detRetPot * realDeflRet : detRetPot,
    swrPct: detRetPot > 0 ? (r.swr / detRetPot) * 100 : 0,
    netMonthly: aid0 ? (useToday ? aid0.netReal : aid0.netNom) : r.netMonthly,
    label: `Baseline (${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })})`,
  };
  const saveBtn = document.getElementById('save-baseline-btn');
  if (saveBtn) saveBtn.textContent = '📌 Baseline saved';
  renderComparisonPanel(r);
}

function renderComparisonPanel(r) {
  const panel = document.getElementById('comparison-panel');
  if (!panel || !baselineSnapshot) { if (panel) panel.style.display = 'none'; return; }
  const useToday = isTodayMoney();
  const baseInflFactor = 1 + (r.p.inflation || 0) / 100;
  const yearsToRet = Math.max(0, r.p.retirementAge - (r.p.currentAgeFrac ?? r.p.currentAge));
  const realDeflRet = Math.pow(1 / baseInflFactor, yearsToRet);
  const detPension = r.detPotByYear?.[0] ?? 0;
  const detCash = r.detCashBalByYear?.[0] ?? 0;
  const detRetPot = detPension + detCash;
  const aid0 = r.annualIncomeData?.[0];
  const cur = {
    prob: r.prob,
    potAtRet: useToday ? detRetPot * realDeflRet : detRetPot,
    swrPct: detRetPot > 0 ? (r.swr / detRetPot) * 100 : 0,
    netMonthly: aid0 ? (useToday ? aid0.netReal : aid0.netNom) : r.netMonthly,
  };
  const b = baselineSnapshot;
  function diffCell(curVal, baseVal, fmtFn) {
    const delta = curVal - baseVal;
    if (Math.abs(delta) < 0.01) return `<strong>${fmtFn(curVal)}</strong>`;
    const better = delta > 0;
    const cls = better ? 'green' : 'red';
    const sign = delta > 0 ? '+' : '';
    return `<strong style="color:var(--${cls})">${fmtFn(curVal)}</strong> <small style="color:var(--${cls})">(${sign}${fmtFn(delta)})</small>`;
  }
  panel.style.display = '';
  panel.innerHTML = `<div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:12px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
      <span style="font-size:0.78rem;font-weight:700;color:var(--text2);letter-spacing:0.04em;text-transform:uppercase">Scenario Comparison</span>
      <button id="clear-baseline-btn" style="font-size:0.75rem;color:var(--text2);background:none;border:none;cursor:pointer;padding:2px 6px;border-radius:4px">✕ Clear</button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;font-size:0.82rem">
      <div style="color:var(--text2);font-weight:600;border-bottom:1px solid var(--border);padding-bottom:4px">${b.label}</div>
      <div style="color:var(--text2);font-weight:600;border-bottom:1px solid var(--border);padding-bottom:4px">Current</div>
      <div><span style="color:var(--text2)">P(success)</span><br><strong>${b.prob.toFixed(1)}%</strong></div>
      <div><span style="color:var(--text2)">P(success)</span><br>${diffCell(cur.prob, b.prob, v => v.toFixed(1) + '%')}</div>
      <div><span style="color:var(--text2)">Pot at retirement</span><br><strong>${fmtGBP(b.potAtRet)}</strong></div>
      <div><span style="color:var(--text2)">Pot at retirement</span><br>${diffCell(cur.potAtRet, b.potAtRet, fmtGBP)}</div>
      <div><span style="color:var(--text2)">SWR</span><br><strong>${b.swrPct.toFixed(2)}%</strong></div>
      <div><span style="color:var(--text2)">SWR</span><br>${diffCell(cur.swrPct, b.swrPct, v => v.toFixed(2) + '%')}</div>
      <div><span style="color:var(--text2)">Net monthly</span><br><strong>${fmtGBP(b.netMonthly)}/mo</strong></div>
      <div><span style="color:var(--text2)">Net monthly</span><br>${diffCell(cur.netMonthly, b.netMonthly, v => fmtGBP(v) + '/mo')}</div>
    </div>
  </div>`;
  document.getElementById('clear-baseline-btn')?.addEventListener('click', () => {
    baselineSnapshot = null;
    panel.style.display = 'none';
    const saveBtn = document.getElementById('save-baseline-btn');
    if (saveBtn) saveBtn.textContent = '📌 Save as Baseline';
  });
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
  const yearsToRetirement = Math.max(0, p.retirementAge - (p.currentAgeFrac ?? p.currentAge));
  const isToday = isTodayMoney();

  // Toggle "At Reduction" column visibility
  const incomeTable = document.getElementById('income-table');
  if (incomeTable) {
    incomeTable.classList.toggle('reduction-col-hidden', !p.reductionEnabled);
  }

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

  // DB pension rows — primary person
  if (p.dbPensions?.length) {
    const snapshotAges = [p.retirementAge, p.spAge, p.reductionAge];
    p.dbPensions.forEach(db => {
      const dbSnaps = cols.map((y, col) => {
        const age = snapshotAges[col];
        if (db.startAge != null && age < db.startAge) return { g: 0, t: 0, n: 0 };
        const annual = age < p.spAge ? (db.preSpAnnual || 0) : (db.postSpAnnual || 0);
        const snapRow = snap[col];
        const d = todayDef(y);
        const g = annual * ciFromNow(y) * d;
        const aggGross = snapRow && snapRow.otherGrossNom > 0 ? snapRow.otherGrossNom * 12 : 0;
        const effRate = aggGross > 0 ? (snapRow.otherTaxNom * 12) / aggGross : 0;
        const t = g * effRate;
        return { g, t, n: g - t };
      });
      rows += row3(db.name || 'DB Pension', dbSnaps[0], dbSnaps[1], dbSnaps[2],
        `Employment income · from age ${db.startAge ?? p.retirementAge}`);
    });
  }

  // DB pension rows — partner
  if (p.partner && p.partner.dbPensions?.length) {
    const snapshotAges = [p.retirementAge, p.spAge, p.reductionAge];
    p.partner.dbPensions.forEach(db => {
      const dbSnaps = cols.map((y, col) => {
        const age = snapshotAges[col];
        const partnerAge = p.partner.currentAge + (age - p.currentAge);
        if (db.startAge != null && partnerAge < db.startAge) return { g: 0, t: 0, n: 0 };
        const annual = partnerAge < p.partner.spAge ? (db.preSpAnnual || 0) : (db.postSpAnnual || 0);
        const d = todayDef(y);
        const g = annual * ciFromNow(y) * d;
        return { g, t: 0, n: g };
      });
      rows += row3(db.name || 'Partner DB Pension', dbSnaps[0], dbSnaps[1], dbSnaps[2],
        `Partner employment income · from age ${db.startAge ?? p.partner.retirementAge}`);
    });
  }

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

  const hasDbPensions = !!(r.p?.dbPensions?.length || r.p?.partner?.dbPensions?.length);

  // Show/hide partner and DB columns
  ['ann-th-partner-sp', 'ann-th-partner-other'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = hasPartner ? '' : 'none';
  });
  const dbTh = document.getElementById('ann-th-db');
  if (dbTh) dbTh.style.display = hasDbPensions ? '' : 'none';

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
    const ageLabel = `${ageDisplay}<br><span style="font-size:0.72rem;color:var(--text2)">${d.calYear}</span>`;
    return `<tr class="${cls}">
      <td>${ageLabel}</td>
      ${cell(d.cashNom, d.cashReal)}
      ${incomeCell(d.pensionNom, d.pensionReal, d.pensionGrossNom, d.pensionGrossReal, d.pensionTaxNom, d.pensionTaxReal)}
      ${incomeCell(d.dbNom || 0, d.dbReal || 0, d.dbGrossNom || 0, d.dbGrossReal || 0, d.dbTaxNom || 0, d.dbTaxReal || 0, !hasDbPensions)}
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

  // ── Fiscal-drag tooltip on tax sub-lines ──────────────────────────────
  const tip = document.getElementById('fiscal-drag-tip');
  const TIP_TEXT = 'Tax rises gradually in today\u2019s prices over time \u2014 <em>fiscal drag</em> (bracket creep): UK tax thresholds are frozen in nominal terms, so inflation erodes the real value of the personal allowance and rate bands, pushing more real income into higher brackets each year.';
  if (tip && !tbody._fiscalTipWired) {
    tbody._fiscalTipWired = true;
    tbody.addEventListener('mouseover', e => {
      const el = e.target.closest('.ann-tax');
      if (!el || !isTodayMoney()) return;
      tip.innerHTML = TIP_TEXT;
      tip.classList.add('visible');
    });
    tbody.addEventListener('mousemove', e => {
      if (!tip.classList.contains('visible')) return;
      const pad = 14;
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let x = e.clientX + pad, y = e.clientY + pad;
      if (x + tw > window.innerWidth  - 8) x = e.clientX - tw - pad;
      if (y + th > window.innerHeight - 8) y = e.clientY - th - pad;
      tip.style.left = x + 'px';
      tip.style.top  = y + 'px';
    });
    tbody.addEventListener('mouseout', e => {
      if (!e.target.closest('.ann-tax')) return;
      tip.classList.remove('visible');
    });
  }
}

// ── Chart helpers ──────────────────────────────────────────────────────────
function isDark() { return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; }
function gridColor() { return isDark() ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'; }
function textColor() { return isDark() ? '#9ca3af' : '#6b7280'; }
function destroyChart(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }

// ── Shared actuals data builder for charts ────────────────────────────────
// Returns chart axis extended left to cover pre-retirement journal entries,
// plus sparse actuals maps keyed by age. Used by all main chart functions.
function buildActualsChartData(r) {
  const p = r.p;
  const calYear = new Date().getFullYear();
  const chartStartAge = r.ages[0];
  const chartEndAge = r.ages[r.ages.length - 1];
  const chartAges = [];
  for (let a = chartStartAge; a <= chartEndAge; a++) chartAges.push(a);
  // If actuals are disabled return empty data immediately
  if (!isActualsEnabled()) {
    const todayIdx = chartAges.indexOf(p.currentAge);
    const showTodayLine = p.currentAge > p.retirementAge && todayIdx >= 0;
    return { chartAges, potActualsByAge: {}, incActualsByAge: {}, todayIdx, showTodayLine };
  }
  // Find the earliest age present in any journal entry
  const journalAgeMin = actualsEvents.filter(e => e.date).reduce((mn, e) => {
    const a = p.currentAge + (new Date(e.date).getFullYear() - calYear);
    return Math.min(mn, a);
  }, r.ages[0]);
  const extStartAge = Math.min(r.ages[0], journalAgeMin);
  if (extStartAge < chartStartAge) {
    for (let a = extStartAge; a < chartStartAge; a++) chartAges.unshift(a);
  }
  // Pot + cash actuals: for each year-bucket take the latest value per pot UUID,
  // then sum those. This ensures multiple snapshots in the same year don't
  // inflate the chart point — only the most recent snapshot per pot is used.
  const _latestByAgeUuid = {};
  actualsEvents
    .filter(e => (e.type === 'pot_valuation' || e.type === 'cash_valuation') && e.date && e.amount != null)
    .forEach(e => {
      const age = p.currentAge + (new Date(e.date).getFullYear() - calYear);
      if (!_latestByAgeUuid[age]) _latestByAgeUuid[age] = {};
      const prev = _latestByAgeUuid[age][e.targetUuid];
      if (!prev || e.date > prev.date) _latestByAgeUuid[age][e.targetUuid] = e;
    });
  const potActualsByAge = {};
  Object.entries(_latestByAgeUuid).forEach(([age, byUuid]) => {
    potActualsByAge[age] = Object.values(byUuid).reduce((s, e) => s + Number(e.amount), 0);
  });
  // Income actuals: sum per calendar-year-bucket
  const incActualsByAge = {};
  actualsEvents
    .filter(e => e.type === 'income_actual' && e.date && e.amount != null)
    .forEach(e => {
      const age = p.currentAge + (new Date(e.date).getFullYear() - calYear);
      incActualsByAge[age] = (incActualsByAge[age] || 0) + Number(e.amount);
    });
  // "Today" vertical marker: only shown when user is already in retirement
  const todayIdx = chartAges.indexOf(p.currentAge);
  const showTodayLine = p.currentAge > p.retirementAge && todayIdx >= 0;
  return { chartAges, potActualsByAge, incActualsByAge, todayIdx, showTodayLine };
}

// ── Pot Chart (Deterministic) ─────────────────────────────────────────────
function renderAccumulationCards(r) {
  const container = document.getElementById('accum-cards');
  if (!container) return;
  const p = r.p;
  const useToday = isTodayMoney();
  const baseInflFactor = 1 + (p.inflation || 0) / 100;
  const yearsToRetirement = Math.max(0, p.retirementAge - (p.currentAgeFrac ?? p.currentAge));
  const deflAtRet = useToday ? Math.pow(1 / baseInflFactor, yearsToRetirement) : 1;

  // Projected total at retirement — authoritative deterministic arrays
  const projPensionNom = r.detPotByYear?.[0] ?? 0;
  const projCashNom = r.detCashBalByYear?.[0] ?? 0;
  const projTotalNom = projPensionNom + projCashNom;
  const projTotalDisp = projTotalNom * deflAtRet;

  // Current pot values split by type
  const currentPensionTotal = (p.pots || []).reduce((s, pot) => s + (pot.value || 0), 0)
    + (p.partner?.pots || []).reduce((s, pot) => s + (pot.value || 0), 0);
  const currentCashTotal = (p.cashPots || []).reduce((s, cp) => s + (cp.value || 0), 0)
    + (p.partner?.cashPots || []).reduce((s, cp) => s + (cp.value || 0), 0);

  // Total contributions split pension vs cash/ISA
  let pensionContribs = 0;
  let cashContribs = 0;
  (p.pots || []).forEach(pot => { pensionContribs += (pot.annualContrib || 0) * yearsToRetirement; });
  if (p.partner) {
    const ytp = Math.max(0, p.partner.retirementAge - (p.partner.currentAgeFrac ?? p.partner.currentAge));
    (p.partner.pots || []).forEach(pot => { pensionContribs += (pot.annualContrib || 0) * ytp; });
  }
  const calcCashContribs = (cashPots, yrs, ownerCurrentAge) => {
    (cashPots || []).forEach(cp => {
      let delayYears = 0;
      if (cp.contribStartMonth) {
        const [cy, cm] = cp.contribStartMonth.split('-').map(Number);
        const now = new Date();
        delayYears = Math.max(0, (cy - now.getFullYear()) * 12 + (cm - 1 - now.getMonth())) / 12;
      }
      const contribYears = Math.max(0, yrs - delayYears);
      cashContribs += (cp.monthlyContrib || 0) * 12 * contribYears;
      if (cp.type === 'lisa' && (cp.monthlyContrib || 0) > 0 && ownerCurrentAge < 50) {
        const eligibleYears = Math.max(0, Math.min(contribYears, 50 - ownerCurrentAge));
        cashContribs += Math.min((cp.monthlyContrib || 0) * 12, 4000) * 0.25 * eligibleYears;
      }
    });
  };
  calcCashContribs(p.cashPots, yearsToRetirement, p.currentAge);
  if (p.partner) {
    const ytp = Math.max(0, p.partner.retirementAge - (p.partner.currentAgeFrac ?? p.partner.currentAge));
    calcCashContribs(p.partner.cashPots, ytp, p.partner.currentAge);
  }
  const totalContribs = pensionContribs + cashContribs;

  // Growth = projected − starting value − contributions, per type
  const pensionGrowthNom = Math.max(0, projPensionNom - currentPensionTotal - pensionContribs);
  const cashGrowthNom   = Math.max(0, projCashNom   - currentCashTotal   - cashContribs);
  const totalGrowthNom  = pensionGrowthNom + cashGrowthNom;

  const contribsDisp        = totalContribs * deflAtRet;
  const pensionContribsDisp = pensionContribs * deflAtRet;
  const cashContribsDisp    = cashContribs * deflAtRet;
  const totalGrowthDisp     = totalGrowthNom * deflAtRet;
  const pensionGrowthDisp   = pensionGrowthNom * deflAtRet;
  const cashGrowthDisp      = cashGrowthNom * deflAtRet;

  const hasCash = projCashNom > 0 || cashContribs > 0;
  const yrs = Math.round(yearsToRetirement);
  container.innerHTML = `
    <div class="accum-card">
      <div class="accum-card-label">Projected pot at retirement</div>
      <div class="accum-card-value">${fmtGBP(projTotalDisp)}</div>
      <div class="accum-card-sub">${yrs} year${yrs !== 1 ? 's' : ''} to go</div>
      <div class="accum-card-split">
        <span>Pension</span><span>${fmtGBP(projPensionNom * deflAtRet)}</span>
        ${hasCash ? `<span>Cash / ISA</span><span>${fmtGBP(projCashNom * deflAtRet)}</span>` : ''}
      </div>
    </div>
    <div class="accum-card">
      <div class="accum-card-label">Total contributions</div>
      <div class="accum-card-value">${fmtGBP(contribsDisp)}</div>
      <div class="accum-card-sub">you add before retirement${useToday ? ' (today\'s money)' : ' (nominal)'}</div>
      <div class="accum-card-split">
        <span>Pension</span><span>${fmtGBP(pensionContribsDisp)}</span>
        ${hasCash ? `<span>Cash / ISA</span><span>${fmtGBP(cashContribsDisp)}</span>` : ''}
      </div>
    </div>
    <div class="accum-card">
      <div class="accum-card-label">Total growth</div>
      <div class="accum-card-value">${fmtGBP(totalGrowthDisp)}</div>
      <div class="accum-card-sub">projected investment return${useToday ? ' (today\'s money)' : ' (nominal)'}</div>
      <div class="accum-card-split">
        <span>Pension</span><span>${fmtGBP(pensionGrowthDisp)}</span>
        ${hasCash ? `<span>Cash / ISA</span><span>${fmtGBP(cashGrowthDisp)}</span>` : ''}
      </div>
    </div>`;
}

function renderPotChart(r) {
  if (!chartAvailable()) return;
  destroyChart('pot');
  const chartEl = document.getElementById('chart-pot');
  if (!chartEl) return;
  const ctx = chartEl.getContext('2d');
  const useToday = isTodayMoney();
  const p = r.p;
  const baseInflFactor = 1 + (p?.inflation || 0) / 100;
  const yearsToRetirement = Math.max(0, p.retirementAge - (p.currentAgeFrac ?? p.currentAge));
  // Deflator indexed from today (year 0 = currentAge)
  const deflatorFromToday = y => Math.pow(1 / baseInflFactor, y);
  const returnPct = r.returnPct ?? 5;
  const bearReturnPct = Math.max(1, returnPct - 2);
  const bullReturnPct = returnPct + 2;

  const { chartAges, potActualsByAge, todayIdx, showTodayLine } = buildActualsChartData(r);

  // Build full age range from currentAge to endAge
  const currentAge = Math.floor(p.currentAge);
  const allAges = [];
  for (let a = currentAge; a <= p.endAge; a++) allAges.push(a);

  // Helper: stitch pre-ret acc array + post-ret det array into a full values array over allAges
  function stitchSeries(accArr, detArr, accOffset) {
    // accArr[0] = value at currentAge, accArr[i] = value at currentAge+i (up to retirementAge)
    // detArr[0] = value at retirementAge, detArr[i] = value at retirementAge+i
    // accOffset = integer offset if accArr starts earlier than currentAge (0 for us)
    return allAges.map(a => {
      const yearFromToday = a - currentAge;
      if (a < p.retirementAge) {
        const i = a - currentAge;
        const v = (accArr && i < accArr.length) ? accArr[i] : null;
        if (v == null) return null;
        return useToday ? v * deflatorFromToday(yearFromToday) : v;
      } else {
        const i = a - p.retirementAge;
        const v = (detArr && i < detArr.length) ? detArr[i] : null;
        if (v == null) return null;
        return useToday ? v * deflatorFromToday(yearFromToday) : v;
      }
    });
  }

  // Base: pension + cash combined
  const basePensionCash = stitchSeries(
    (r.accPensionByYear && r.accCashByYear)
      ? Array.from(r.accPensionByYear).map((v, i) => v + (r.accCashByYear[i] || 0))
      : null,
    Array.from(r.detPotByYear || []).map((v, i) => v + ((r.detCashBalByYear || [])[i] || 0)),
    0
  );

  // Bear: pension + cash combined
  const bearPensionCash = (r.bearDetPotByYear) ? stitchSeries(
    (r.bearAccPensionByYear && r.bearAccCashByYear)
      ? Array.from(r.bearAccPensionByYear).map((v, i) => v + (r.bearAccCashByYear[i] || 0))
      : null,
    Array.from(r.bearDetPotByYear).map((v, i) => v + ((r.bearDetCashBalByYear || [])[i] || 0)),
    0
  ) : null;

  // Bull: pension + cash combined
  const bullPensionCash = (r.bullDetPotByYear) ? stitchSeries(
    (r.bullAccPensionByYear && r.bullAccCashByYear)
      ? Array.from(r.bullAccPensionByYear).map((v, i) => v + (r.bullAccCashByYear[i] || 0))
      : null,
    Array.from(r.bullDetPotByYear).map((v, i) => v + ((r.bullDetCashBalByYear || [])[i] || 0)),
    0
  ) : null;

  // Actuals overlay
  const retDeflator = i => Math.pow(1 / baseInflFactor, yearsToRetirement + i);
  const hasActuals = Object.keys(potActualsByAge).length > 0;
  const actualsValues = allAges.map(a => {
    if (potActualsByAge[a] == null) return null;
    const yearFromToday = a - currentAge;
    return useToday ? potActualsByAge[a] * deflatorFromToday(yearFromToday) : potActualsByAge[a];
  });

  const spAgeIdx = allAges.indexOf(p.spAge);
  const retAgeIdx = allAges.indexOf(p.retirementAge);
  const todayAgeIdx = allAges.indexOf(currentAge);

  const titleEl = document.getElementById('pot-chart-title');
  if (titleEl) titleEl.textContent = `Pot Balance — ${returnPct}% base · ${bearReturnPct}% bear · ${bullReturnPct}% bull`;

  const noteEl = document.getElementById('pot-chart-note');
  if (noteEl) noteEl.textContent = `Deterministic projection from today. Dashed lines show ±2% return sensitivity. Amber = State Pension age. Orange = Retirement.`;

  const overlayPlugin = {
    id: 'overlay',
    afterDraw(chart) {
      const { ctx: c, scales: { x, y } } = chart;
      const drawVLine = (idx, color, dash, label, labelY) => {
        if (idx < 0) return;
        const xPx = x.getPixelForValue(idx);
        c.save(); c.strokeStyle = color; c.lineWidth = 1.5; c.setLineDash(dash);
        c.beginPath(); c.moveTo(xPx, y.top); c.lineTo(xPx, y.bottom); c.stroke();
        c.fillStyle = color; c.font = '11px system-ui,sans-serif';
        c.textAlign = 'left'; c.fillText(label, xPx + 4, labelY); c.restore();
      };
      drawVLine(retAgeIdx, '#ea580c', [6, 4], 'Retirement', y.top + 14);
      drawVLine(spAgeIdx, '#d97706', [6, 4], 'State Pension', y.top + 28);
      if (showTodayLine) {
        const xPx = x.getPixelForValue(allAges.indexOf(currentAge));
        c.save(); c.strokeStyle = '#2563eb'; c.lineWidth = 1.5; c.setLineDash([4, 4]);
        c.beginPath(); c.moveTo(xPx, y.top); c.lineTo(xPx, y.bottom); c.stroke();
        c.fillStyle = '#2563eb'; c.font = '11px system-ui,sans-serif';
        c.textAlign = 'left'; c.fillText('Today', xPx + 4, y.top + 42); c.restore();
      }
    }
  };

  const datasets = [
    { label: `${returnPct}% return`, data: basePensionCash, borderColor: 'rgba(37,99,235,1)', backgroundColor: 'rgba(37,99,235,0.08)', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2, spanGaps: false },
  ];
  if (bearPensionCash) {
    datasets.push({ label: `${bearReturnPct}% (bear)`, data: bearPensionCash, borderColor: 'rgba(220,38,38,0.55)', backgroundColor: 'transparent', fill: false, tension: 0.3, pointRadius: 0, borderWidth: 1.5, borderDash: [5, 4], spanGaps: false });
  }
  if (bullPensionCash) {
    datasets.push({ label: `${bullReturnPct}% (bull)`, data: bullPensionCash, borderColor: 'rgba(22,163,74,0.55)', backgroundColor: 'transparent', fill: false, tension: 0.3, pointRadius: 0, borderWidth: 1.5, borderDash: [5, 4], spanGaps: false });
  }
  if (hasActuals) {
    datasets.push({ label: 'Actual total pot', data: actualsValues, borderColor: '#16a34a', backgroundColor: '#16a34a', showLine: true, tension: 0.2, pointRadius: 5, pointHoverRadius: 7, borderWidth: 2, spanGaps: false, fill: false });
  }

  // Sequence of Returns Risk overlay
  const sorrEnabled = document.getElementById('sorr-enabled')?.checked;
  let sorrResult = null;
  if (sorrEnabled && r.startPensionPot > 0) {
    const crashPct = +(document.getElementById('sorr-crash-pct')?.value ?? -25);
    const crashYears = +(document.getElementById('sorr-crash-years')?.value ?? 3);
    sorrResult = runSorrProjection(r, crashPct, crashYears);
    if (sorrResult) {
      const sorrData = stitchSeries(
        (r.accPensionByYear && r.accCashByYear)
          ? Array.from(r.accPensionByYear).map((v, i) => v + (r.accCashByYear[i] || 0))
          : null,
        Array.from(sorrResult.detPotByYear).map((v, i) => v + ((sorrResult.detCashBalByYear || [])[i] || 0)),
        0
      );
      datasets.push({
        label: `Sequence of Returns Risk (${crashPct}%/yr × ${crashYears}yr)`,
        data: sorrData,
        borderColor: 'rgba(220,38,38,0.9)',
        backgroundColor: 'transparent',
        fill: false,
        tension: 0.3,
        pointRadius: 0,
        borderWidth: 2,
        borderDash: [6, 3],
        spanGaps: false
      });
    }
  }

  charts['pot'] = new Chart(ctx, {
    type: 'line',
    plugins: [overlayPlugin],
    data: { labels: allAges, datasets },
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

  // Render SORR summary callout + table if enabled
  renderSorrSummary(sorrResult, r.p, r);
}

// ── Pot Chart (Monte Carlo Fan) ───────────────────────────────────────────
function renderMonteCarloChart(r) {
  if (!chartAvailable()) return;
  destroyChart('montecarlo');
  const chartEl = document.getElementById('chart-montecarlo');
  if (!chartEl) return;
  const ctx = chartEl.getContext('2d');
  const [p5, p25, p50, p75, p95] = r.percentileData;
  const p = r.p;
  const useToday = isTodayMoney();
  const baseInflFactor = 1 + (p?.inflation || 0) / 100;
  const yearsToRetirement = Math.max(0, p.retirementAge - (p.currentAgeFrac ?? p.currentAge));
  const deflator = i => Math.pow(1 / baseInflFactor, yearsToRetirement + i);

  const { chartAges, potActualsByAge, todayIdx, showTodayLine } = buildActualsChartData(r);
  const spAgeIdx = chartAges.indexOf(p.spAge);

  // Map a percentile series onto the extended chart axis; null before retirementAge or currentAge
  const mapSeries = (arr) => chartAges.map(a => {
    if (a < r.ages[0] || a < p.currentAge) return null;
    const i = a - r.ages[0];
    return i < arr.length ? (useToday ? arr[i] * deflator(i) : arr[i]) : null;
  });

  // Actuals overlay: sparse, spanGaps: false
  const hasActuals = Object.keys(potActualsByAge).length > 0;
  const actualsValues = chartAges.map(a => {
    if (potActualsByAge[a] == null) return null;
    const simI = Math.max(0, a - r.ages[0]);
    return useToday ? potActualsByAge[a] * deflator(simI) : potActualsByAge[a];
  });

  const overlayPlugin = {
    id: 'overlay',
    afterDraw(chart) {
      const { ctx: c, scales: { x, y } } = chart;
      if (spAgeIdx >= 0) {
        const xPx = x.getPixelForValue(spAgeIdx);
        c.save(); c.strokeStyle = '#d97706'; c.lineWidth = 1.5; c.setLineDash([6, 4]);
        c.beginPath(); c.moveTo(xPx, y.top); c.lineTo(xPx, y.bottom); c.stroke();
        c.fillStyle = '#d97706'; c.font = '11px system-ui,sans-serif';
        c.textAlign = 'left'; c.fillText('State Pension', xPx + 4, y.top + 14); c.restore();
      }
      if (showTodayLine) {
        const xPx = x.getPixelForValue(todayIdx);
        c.save(); c.strokeStyle = '#2563eb'; c.lineWidth = 1.5; c.setLineDash([4, 4]);
        c.beginPath(); c.moveTo(xPx, y.top); c.lineTo(xPx, y.bottom); c.stroke();
        c.fillStyle = '#2563eb'; c.font = '11px system-ui,sans-serif';
        c.textAlign = 'left'; c.fillText('Today', xPx + 4, y.top + 28); c.restore();
      }
    }
  };

  const datasets = [
    { label: '95th', data: mapSeries(p95), borderColor: 'rgba(37,99,235,0.2)', backgroundColor: 'rgba(37,99,235,0.08)', fill: '+1', tension: 0.3, pointRadius: 0, borderWidth: 1, spanGaps: false },
    { label: '75th', data: mapSeries(p75), borderColor: 'rgba(37,99,235,0.4)', backgroundColor: 'rgba(37,99,235,0.12)', fill: '+1', tension: 0.3, pointRadius: 0, borderWidth: 1, spanGaps: false },
    { label: 'Median', data: mapSeries(p50), borderColor: 'rgba(37,99,235,1)', backgroundColor: 'transparent', fill: false, tension: 0.3, pointRadius: 0, borderWidth: 2, spanGaps: false },
    { label: '25th', data: mapSeries(p25), borderColor: 'rgba(37,99,235,0.4)', backgroundColor: 'rgba(37,99,235,0.12)', fill: '+1', tension: 0.3, pointRadius: 0, borderWidth: 1, spanGaps: false },
    { label: '5th', data: mapSeries(p5), borderColor: 'rgba(37,99,235,0.2)', backgroundColor: 'rgba(37,99,235,0.08)', fill: false, tension: 0.3, pointRadius: 0, borderWidth: 1, spanGaps: false },
  ];
  if (hasActuals) {
    datasets.push({ label: 'Actual total pot', data: actualsValues, borderColor: '#16a34a', backgroundColor: '#16a34a', showLine: true, tension: 0.2, pointRadius: 5, pointHoverRadius: 7, borderWidth: 2, spanGaps: false, fill: false });
  }

  charts['montecarlo'] = new Chart(ctx, {
    type: 'line',
    plugins: [overlayPlugin],
    data: { labels: chartAges, datasets },
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
  const yearsToRetirement = Math.max(0, r.p.retirementAge - (r.p.currentAgeFrac ?? r.p.currentAge));
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
  const ruinData = r.survivalByAge.map(v => +(100 - v).toFixed(1));
  const bgColors = ruinData.map(v => v <= 10 ? 'rgba(22,163,74,0.15)' : v <= 25 ? 'rgba(217,119,6,0.15)' : 'rgba(220,38,38,0.18)');
  const lineColors = ruinData.map(v => v <= 10 ? '#16a34a' : v <= 25 ? '#d97706' : '#dc2626');
  const thresholdPlugin = {
    id: 'ruinThreshold',
    afterDraw(chart) {
      const { ctx: c, scales: { x, y } } = chart;
      const yPx = y.getPixelForValue(10);
      c.save(); c.strokeStyle = '#dc2626'; c.lineWidth = 1.2; c.setLineDash([5, 4]);
      c.beginPath(); c.moveTo(x.left, yPx); c.lineTo(x.right, yPx); c.stroke();
      c.fillStyle = '#dc2626'; c.font = '10px system-ui,sans-serif';
      c.textAlign = 'right'; c.fillText('10% risk threshold', x.right - 4, yPx - 4); c.restore();
    }
  };
  const gradColors = ruinData.map((_, i) => lineColors[i]);
  charts['survival'] = new Chart(ctx, {
    type: 'line',
    plugins: [thresholdPlugin],
    data: {
      labels: r.ages,
      datasets: [{
        label: 'P(Ruin)',
        data: ruinData,
        borderColor: '#dc2626',
        backgroundColor: ctx => {
          const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, ctx.chart.height);
          g.addColorStop(0, 'rgba(220,38,38,0.25)');
          g.addColorStop(1, 'rgba(220,38,38,0.02)');
          return g;
        },
        fill: true, tension: 0.35, pointRadius: 0, borderWidth: 2,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `P(Ruin): ${ctx.parsed.y.toFixed(1)}%` } } },
      scales: {
        x: { ticks: { color: textColor() }, grid: { color: gridColor() }, title: { display: true, text: 'Age', color: textColor() } },
        y: { min: 0, max: 100, ticks: { color: textColor(), callback: v => v + '%' }, grid: { color: gridColor() }, title: { display: true, text: 'Probability of Ruin (%)', color: textColor() } }
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

  const prevIdx = Number.parseInt(localStorage.getItem('taxYearIdx') ?? selectEl.value ?? '0', 10);
  const hasPartner = !!r.p?.partner;
  selectEl.innerHTML = rows.map((d, idx) => {
    const age = hasPartner ? `${d.age}/${d.partnerAge}` : `${d.age}`;
    return `<option value="${idx}">${d.calYear} (Age ${age})</option>`;
  }).join('');

  const selectedIdx = Number.isFinite(prevIdx) ? Math.max(0, Math.min(rows.length - 1, prevIdx)) : 0;
  selectEl.value = String(selectedIdx);
  localStorage.setItem('taxYearIdx', String(selectedIdx));

  const d = rows[selectedIdx];
  const useToday = isTodayMoney();

  // ── Inflation factors ──────────────────────────────────────────────────────
  const _infl     = 1 + (r.p?.inflation || 0) / 100;
  const _ytr      = Math.max(0, (r.p?.retirementAge || 0) - ((r.p?.currentAgeFrac ?? r.p?.currentAge) || 0));
  const ciFromNow = Math.pow(_infl, _ytr + selectedIdx);
  const todayDeflator = ciFromNow > 0 ? 1 / ciFromNow : 1;
  const scale     = useToday ? todayDeflator : 1;
  const m = v => (v * scale) / 12;   // nominal annual → monthly display
  const a = v => v * scale;           // nominal annual → annual display

  // ── Per-source other income items ──────────────────────────────────────────
  const ageCtxTax = { currentAge: d.age, retirementAge: r.p.retirementAge, yearsToRetirement: _ytr, baseInflFactor: _infl };
  const otherItems = [
    ...calcOtherIncomesNet(r.p?.incomes || [], ciFromNow, ageCtxTax).items,
    ...calcDbIncome(r.p?.dbPensions, r.p?.spAge ?? 999, d.age, ciFromNow).items,
  ].filter(it => it.gross > 0);
  // Add taxable cash savings interest as a synthetic savings income item
  const _cashInterestAnn = d.cashInterestAnn || 0;
  if (_cashInterestAnn > 0) {
    otherItems.push({ name: 'Cash savings interest', type: 'savings', gross: _cashInterestAnn });
  }
  const _partnerRetired = !!(hasPartner && d.partnerAge !== null && d.partnerAge >= r.p.partner.retirementAge);
  const partnerOtherItems = [
    ...(_partnerRetired && r.p.partner?.incomes?.length
      ? calcOtherIncomesNet(r.p.partner.incomes, ciFromNow, { currentAge: d.partnerAge, retirementAge: r.p.partner.retirementAge, yearsToRetirement: Math.max(0, r.p.partner.retirementAge - (r.p.partner.currentAgeFrac ?? r.p.partner.currentAge)), baseInflFactor: _infl }).items
      : []),
    ...(hasPartner && d.partnerAge !== null
      ? calcDbIncome(r.p.partner?.dbPensions, r.p.partner?.spAge ?? 999, d.partnerAge, ciFromNow).items
      : []),
  ].filter(it => it.gross > 0);

  // ── Per-person pot fractions from simulation ───────────────────────────────
  const primaryPotFrac = r.primaryPotFrac     ?? 1.0;
  const primaryTFrac   = d.primaryTaxFreeFracAnn ?? r.primaryTaxFreeFrac ?? r.taxFreeFrac;
  const partnerTFrac   = d.partnerTaxFreeFracAnn ?? r.partnerTaxFreeFrac ?? r.taxFreeFrac;

  // Compute cumulative LSA used up to (but not including) the selected year
  let cumulPrimaryTaxFreeUsed = 0;
  let cumulPartnerTaxFreeUsed = 0;
  for (let i = 0; i < selectedIdx; i++) {
    const rd = rows[i];
    const priDraw = rd.pensionGrossNom * 12 * primaryPotFrac;
    const parDraw = rd.pensionGrossNom * 12 * (1 - primaryPotFrac);
    cumulPrimaryTaxFreeUsed = Math.min(LSA, cumulPrimaryTaxFreeUsed + priDraw * (rd.primaryTaxFreeFracAnn ?? r.taxFreeFrac));
    cumulPartnerTaxFreeUsed = Math.min(LSA, cumulPartnerTaxFreeUsed + parDraw * (rd.partnerTaxFreeFracAnn ?? r.taxFreeFrac));
  }

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
  const yourByType = { employment: 0, property: 0, savings: 0, dividends: 0 };
  otherItems.forEach(it => { const t = it.type || 'employment'; if (t in yourByType) yourByType[t] += it.gross; else yourByType.employment += it.gross; });
  const partByType = { employment: 0, property: 0, savings: 0, dividends: 0 };
  partnerOtherItems.forEach(it => { const t = it.type || 'employment'; if (t in partByType) partByType[t] += it.gross; else partByType.employment += it.gross; });
  const primTc  = calcPensionTax(primaryDWAnn, spGrossAnn, hasStatePension, primaryTFrac, yourByType, d.calYear);
  const partnTc = hasPartner
    ? calcPensionTax(partnerDWAnn, partnerSpGrossAnn, hasPartnerSP, partnerTFrac, partByType, d.calYear)
    : null;

  // ── Summary table row helpers ──────────────────────────────────────────────
  const incRow = (label, gross, tax, net, indent) =>
    `<tr${indent ? ' class="tx-sub-row"' : ''}><td>${label}</td>` +
    `<td class="num">${fmtGBP(gross)}</td><td class="num">${tax === null ? '—' : fmtGBP(tax)}</td><td class="num">${fmtGBP(net)}</td></tr>`;

  // Per-type other income rows with correct rate badges
  const otherRowsHtml = (items, tc, fmt, calYr, indent = false) => {
    if (items.length === 0) return '';
    const prefix   = indent ? '↳ ' : '';
    const rowClass = indent ? ' class="tx-sub-row"' : '';
    const typeConfigs = [
      { key: 'employment', label: 'Employment / Trading', rate: '20/40/45%',               taxField: 'employmentTax' },
      { key: 'property',   label: 'Property / Rental',   rate: calYr >= 2027 ? '22/42/47%' : '20/40/45%', taxField: 'propertyTax' },
      { key: 'savings',    label: 'Savings / Interest',  rate: calYr >= 2027 ? '22/42/47%' : '20/40/45%', taxField: 'savingsTax' },
      { key: 'dividends',  label: 'Dividends',           rate: calYr >= 2026 ? '10.75/35.75/39.35%' : '8.75/33.75/39.35%', taxField: 'dividendTax' },
    ];
    let html = '';
    for (const cfg of typeConfigs) {
      const typeItems = items.filter(it => (it.type || 'employment') === cfg.key);
      if (typeItems.length === 0) continue;
      const typeGross = typeItems.reduce((s, it) => s + it.gross, 0);
      const typeTax = tc[cfg.taxField] || 0;
      const typeNet = typeGross - typeTax;
      const rateTag = `<small class="tx-rate">${cfg.rate}</small>`;
      if (typeItems.length === 1) {
        html += `<tr${rowClass}><td>${prefix}${typeItems[0].name || cfg.label}${rateTag}</td>` +
          `<td class="num">${fmtGBP(fmt(typeGross))}</td><td class="num">${fmtGBP(fmt(typeTax))}</td><td class="num">${fmtGBP(fmt(typeNet))}</td></tr>`;
      } else {
        html += `<tr${rowClass}><td>${prefix}${cfg.label}${rateTag}</td>` +
          `<td class="num">${fmtGBP(fmt(typeGross))}</td><td class="num">${fmtGBP(fmt(typeTax))}</td><td class="num">${fmtGBP(fmt(typeNet))}</td></tr>`;
        typeItems.forEach(it => {
          const frac = typeGross > 0 ? it.gross / typeGross : 0;
          const itemTax = typeTax * frac;
          const itemNet = it.gross - itemTax;
          html += `<tr class="tx-sub-row"><td>↳ ${it.name || cfg.label}</td>` +
            `<td class="num">${fmtGBP(fmt(it.gross))}</td><td class="num">${fmtGBP(fmt(itemTax))}</td><td class="num">${fmtGBP(fmt(itemNet))}</td></tr>`;
        });
      }
    }
    return html;
  };

  const cashRow = cashAnn > 0
    ? `<tr><td>Cash / ISA Withdrawals<small class="tx-rate">return of capital</small></td>` +
      `<td class="num">${fmtGBP(m(cashAnn))}</td><td class="num">—</td><td class="num">${fmtGBP(m(cashAnn))}</td></tr>`
    : '';
  const cashRowIndented = cashAnn > 0
    ? `<tr class="tx-sub-row"><td>↳ Cash / ISA Withdrawals<small class="tx-rate">return of capital</small></td>` +
      `<td class="num">${fmtGBP(m(cashAnn))}</td><td class="num">—</td><td class="num">${fmtGBP(m(cashAnn))}</td></tr>`
    : '';
  const cashRowAnn = cashAnn > 0
    ? `<tr><td>Cash / ISA Withdrawals<small class="tx-rate">return of capital</small></td>` +
      `<td class="num">${fmtGBP(a(cashAnn))}</td><td class="num">—</td><td class="num">${fmtGBP(a(cashAnn))}</td></tr>`
    : '';
  const cashRowIndentedAnn = cashAnn > 0
    ? `<tr class="tx-sub-row"><td>↳ Cash / ISA Withdrawals<small class="tx-rate">return of capital</small></td>` +
      `<td class="num">${fmtGBP(a(cashAnn))}</td><td class="num">—</td><td class="num">${fmtGBP(a(cashAnn))}</td></tr>`
    : '';

  let summaryTbody, totalGross, totalTax, totalNet;
  let annualSummaryTbody, annualTotalGross, annualTotalTax, annualTotalNet;

  if (!hasPartner) {
    summaryTbody =
      incRow('Pension Pots Drawdown', m(primaryDWAnn), m(primTc.pensionTax), m(primTc.pensionNet), false) +
      cashRow +
      (hasStatePension ? incRow('State Pension', m(spGrossAnn), m(primTc.spTax), m(spGrossAnn) - m(primTc.spTax), false) : '') +
      otherRowsHtml(otherItems, primTc, m, d.calYear);
    totalGross = m(primaryDWAnn + cashAnn + spGrossAnn + yourOtherGross);
    totalTax   = m(primTc.pensionTax + primTc.spTax + primTc.otherTax);
    totalNet   = totalGross - totalTax;
    annualSummaryTbody =
      incRow('Pension Pots Drawdown', a(primaryDWAnn), a(primTc.pensionTax), a(primTc.pensionNet), false) +
      cashRowAnn +
      (hasStatePension ? incRow('State Pension', a(spGrossAnn), a(primTc.spTax), a(spGrossAnn) - a(primTc.spTax), false) : '') +
      otherRowsHtml(otherItems, primTc, a, d.calYear);
    annualTotalGross = a(primaryDWAnn + cashAnn + spGrossAnn + yourOtherGross);
    annualTotalTax   = a(primTc.pensionTax + primTc.spTax + primTc.otherTax);
    annualTotalNet   = annualTotalGross - annualTotalTax;
  } else {
    summaryTbody =
      `<tr class="tx-group-header"><th colspan="4">You</th></tr>` +
      incRow('↳ Pension Pots (your share)', m(primaryDWAnn), m(primTc.pensionTax), m(primTc.pensionNet), true) +
      cashRowIndented +
      (hasStatePension ? incRow('↳ State Pension', m(spGrossAnn), m(primTc.spTax), m(spGrossAnn) - m(primTc.spTax), true) : '') +
      otherRowsHtml(otherItems, primTc, m, d.calYear, true) +
      `<tr class="tx-group-header"><th colspan="4">Partner</th></tr>` +
      incRow('↳ Pension Pots (partner share)', m(partnerDWAnn), m(partnTc.pensionTax), m(partnTc.pensionNet), true) +
      (hasPartnerSP ? incRow('↳ State Pension', m(partnerSpGrossAnn), m(partnTc.spTax), m(partnerSpGrossAnn) - m(partnTc.spTax), true) : '') +
      otherRowsHtml(partnerOtherItems, partnTc, m, d.calYear, true);
    totalGross = m(primaryDWAnn + cashAnn + spGrossAnn + yourOtherGross + partnerDWAnn + partnerSpGrossAnn + partOtherGross);
    totalTax   = m(primTc.pensionTax + primTc.spTax + primTc.otherTax + partnTc.pensionTax + partnTc.spTax + partnTc.otherTax);
    totalNet   = totalGross - totalTax;
    annualSummaryTbody =
      `<tr class="tx-group-header"><th colspan="4">You</th></tr>` +
      incRow('↳ Pension Pots (your share)', a(primaryDWAnn), a(primTc.pensionTax), a(primTc.pensionNet), true) +
      cashRowIndentedAnn +
      (hasStatePension ? incRow('↳ State Pension', a(spGrossAnn), a(primTc.spTax), a(spGrossAnn) - a(primTc.spTax), true) : '') +
      otherRowsHtml(otherItems, primTc, a, d.calYear, true) +
      `<tr class="tx-group-header"><th colspan="4">Partner</th></tr>` +
      incRow('↳ Pension Pots (partner share)', a(partnerDWAnn), a(partnTc.pensionTax), a(partnTc.pensionNet), true) +
      (hasPartnerSP ? incRow('↳ State Pension', a(partnerSpGrossAnn), a(partnTc.spTax), a(partnerSpGrossAnn) - a(partnTc.spTax), true) : '') +
      otherRowsHtml(partnerOtherItems, partnTc, a, d.calYear, true);
    annualTotalGross = a(primaryDWAnn + cashAnn + spGrossAnn + yourOtherGross + partnerDWAnn + partnerSpGrossAnn + partOtherGross);
    annualTotalTax   = a(primTc.pensionTax + primTc.spTax + primTc.otherTax + partnTc.pensionTax + partnTc.spTax + partnTc.otherTax);
    annualTotalNet   = annualTotalGross - annualTotalTax;
  }

  // ── Per-person tax workings builder ───────────────────────────────────────
  function personWorkings(label, dwAnn, tfFrac, spAnn, hasSP_, items_, cumulTaxFreeUsed = 0, tc_ = null, calYr = 2026, mode = 'ufpls') {
    const taxFreeAnn_     = dwAnn * tfFrac;
    const pensionTaxable_ = dwAnn - taxFreeAnn_;
    const otherGross_     = items_.reduce((s, it) => s + it.gross, 0);
    const totalTaxable_   = pensionTaxable_ + (hasSP_ ? spAnn : 0) + otherGross_;
    const bands_          = incomeTaxBands(totalTaxable_);
    // Use tc_ values for attribution if provided; else fall back to old diff-stacking
    const pensionTaxAnn_ = tc_ ? tc_.pensionTax : incomeTax(pensionTaxable_);
    const spTaxAnn_      = tc_ ? tc_.spTax : (incomeTax(pensionTaxable_ + (hasSP_ ? spAnn : 0)) - incomeTax(pensionTaxable_));
    const totalTax_      = tc_ ? (tc_.pensionTax + tc_.spTax + tc_.otherTax) : bands_.totalTax;

    const tapered_ = bands_.effectivePA < 12570;
    const paNote_  = tapered_
      ? `£${Math.round(bands_.effectivePA).toLocaleString()} (tapered — income exceeds £100,000)`
      : `£${bands_.effectivePA.toLocaleString()} (standard)`;

    // ── Per-source band breakdown for Step 3 ──────────────────────────────
    const ePA_    = bands_.effectivePA;
    const propBR_ = calYr >= PROP_SAV_RATE_CHANGE_YEAR ? PROP_SAV_BR_RATE : BR_RATE;
    const propHR_ = calYr >= PROP_SAV_RATE_CHANGE_YEAR ? PROP_SAV_HR_RATE : HR_RATE;
    const propAR_ = calYr >= PROP_SAV_RATE_CHANGE_YEAR ? PROP_SAV_AR_RATE : AR_RATE;
    const divBR_  = calYr >= DIV_RATE_CHANGE_YEAR ? DIV_BR_RATE : DIV_BR_RATE_OLD;
    const divHR_  = calYr >= DIV_RATE_CHANGE_YEAR ? DIV_HR_RATE : DIV_HR_RATE_OLD;
    // Returns band-slice amounts for `inc` stacked on top of `base` lower-tier income.
    function bSplit_(inc, base, brR, hrR, arR) {
      if (inc <= 0) return null;
      const paLeft  = Math.max(0, ePA_ - base);
      const taxable = Math.max(0, inc - paLeft);
      if (taxable <= 0) return null;
      const bbUsed = Math.max(0, base - ePA_);
      const bbLeft = Math.max(0, BR_LIMIT - bbUsed);
      const br     = Math.min(taxable, bbLeft);
      const hbLeft = Math.max(0, (HR_LIMIT - PA - BR_LIMIT) - Math.max(0, bbUsed - BR_LIMIT));
      const hr     = Math.min(Math.max(0, taxable - bbLeft), hbLeft);
      const ar     = Math.max(0, taxable - bbLeft - hbLeft);
      return { br, hr, ar };
    }
    function rStr_(r) { const v = r * 100; return v % 1 === 0 ? v + '%' : v.toFixed(2) + '%'; }
    function srcRows_(lbl, inc, base, brR, hrR, arR) {
      const s = bSplit_(inc, base, brR, hrR, arR);
      if (!s) return { html: '', newBase: base + inc };
      const rows = [];
      if (s.br > 0) rows.push(`<tr><td>${lbl}: ${fmtGBP(s.br)}/yr &times; ${rStr_(brR)}</td><td class="num">= ${fmtA(s.br * brR)}</td></tr>`);
      if (s.hr > 0) rows.push(`<tr><td>${lbl}: ${fmtGBP(s.hr)}/yr &times; ${rStr_(hrR)}</td><td class="num">= ${fmtA(s.hr * hrR)}</td></tr>`);
      if (s.ar > 0) rows.push(`<tr><td>${lbl}: ${fmtGBP(s.ar)}/yr &times; ${rStr_(arR)}</td><td class="num">= ${fmtA(s.ar * arR)}</td></tr>`);
      return { html: rows.join(''), newBase: base + inc };
    }
    let step3Rows_ = '';
    let s3b_ = 0;
    if (pensionTaxable_ > 0) {
      const r = srcRows_('Pension drawdown', pensionTaxable_, s3b_, BR_RATE, HR_RATE, AR_RATE);
      step3Rows_ += r.html; s3b_ = r.newBase;
    }
    if (hasSP_ && spAnn > 0) {
      const r = srcRows_('State pension', spAnn, s3b_, BR_RATE, HR_RATE, AR_RATE);
      step3Rows_ += r.html; s3b_ = r.newBase;
    }
    items_.filter(it => (it.type || 'employment') === 'employment').forEach(it => {
      if (it.gross > 0) { const r = srcRows_(it.name || 'Employment income', it.gross, s3b_, BR_RATE, HR_RATE, AR_RATE); step3Rows_ += r.html; s3b_ = r.newBase; }
    });
    items_.filter(it => it.type === 'property').forEach(it => {
      if (it.gross > 0) { const r = srcRows_(it.name || 'Property income', it.gross, s3b_, propBR_, propHR_, propAR_); step3Rows_ += r.html; s3b_ = r.newBase; }
    });
    items_.filter(it => it.type === 'savings').forEach(it => {
      if (it.gross > 0) { const r = srcRows_(it.name || 'Savings income', it.gross, s3b_, propBR_, propHR_, propAR_); step3Rows_ += r.html; s3b_ = r.newBase; }
    });
    items_.filter(it => it.type === 'dividends').forEach(it => {
      if (it.gross > 0) { const r = srcRows_(it.name || 'Dividends', it.gross, s3b_, divBR_, divHR_, DIV_AR_RATE); step3Rows_ += r.html; s3b_ = r.newBase; }
    });
    if (!step3Rows_) step3Rows_ = `<tr class="tw-nil"><td colspan="2">All income within personal allowance — no tax due</td></tr>`;

    // ── Step 2 HTML — from Apr 2027 PA no longer flows to property/savings/dividends ──
    const _t1Gross = pensionTaxable_ + (hasSP_ ? spAnn : 0) +
      items_.filter(it => (it.type || 'employment') === 'employment').reduce((s, it) => s + it.gross, 0);
    const _t2PlusGross = items_
      .filter(it => it.type === 'property' || it.type === 'savings' || it.type === 'dividends')
      .reduce((s, it) => s + it.gross, 0);
    const _paToNonSavOnly = calYr >= PROP_SAV_RATE_CHANGE_YEAR && _t2PlusGross > 0;
    const step2Html_ = _paToNonSavOnly
      ? `<p class="tw-step-note">From April 2027, the Personal Allowance only applies to non-savings income (pension drawdown, state pension, employment). Property, savings and dividend income are taxed from the bottom of their own rate bands without Personal Allowance benefit (Finance Bill 2025-26).</p>
         <table class="tw-table">
           <tr><td>Personal allowance</td><td class="num">${paNote_}</td></tr>
           <tr><td>Income eligible for Personal Allowance (e.g. Pension / State Pension / Employment)</td><td class="num">${fmtN(_t1Gross)}</td></tr>
           <tr><td>Allowance used</td><td class="num">${fmtN(Math.min(bands_.effectivePA, _t1Gross))}</td></tr>
           <tr><td>Income ineligible for Personal Allowance (e.g. Property / savings interest / dividends)</td><td class="num">${fmtN(_t2PlusGross)}</td></tr>
         </table>`
      : `<table class="tw-table">
           <tr><td>Personal allowance</td><td class="num">${paNote_}</td></tr>
           <tr><td>Allowance used</td><td class="num">${fmtN(bands_.paUsed)}</td></tr>
           <tr class="tw-total"><td>Income above allowance (taxable)</td><td class="num">${fmtN(bands_.above)}</td></tr>
         </table>`;

    return `<div class="tw-person-section">
      <div class="tw-person-heading">${label}</div>
      <div class="tw-step">
        <div class="tw-step-title">Step 1 — Gross income &amp; tax-free cash</div>
        <table class="tw-table">
          ${dwAnn > 0 ? `<tr><td>Pension pot drawdown (gross)</td><td class="num">${fmtN(dwAnn)}</td></tr>
          <tr class="tw-sub"><td>↳ Tax-free portion (${mode === 'pcls' ? `0% — PCLS lump sum taken at retirement` : mode === 'none' ? '0% — no tax-free cash' : `${fmtPct(tfFrac * 100)} — UFPLS`})</td><td class="num">− ${fmtN(taxFreeAnn_)}</td></tr>
          ${mode !== 'pcls' ? `<tr class="tw-sub tw-sub2"><td>&nbsp;&nbsp;↳ ${fmtGBP(cumulTaxFreeUsed + taxFreeAnn_)} used · ${fmtGBP(Math.max(0, LSA - cumulTaxFreeUsed - taxFreeAnn_))} remaining of ${fmtGBP(LSA)}</td><td class="num"></td></tr>` : ''}
          <tr class="tw-sub tw-subtotal"><td>↳ Taxable pension drawdown</td><td class="num">${fmtN(pensionTaxable_)}</td></tr>` : ''}
          ${hasSP_ ? `<tr><td>State pension</td><td class="num">${fmtN(spAnn)}</td></tr>` : ''}
          ${items_.map(it => `<tr><td>${it.name || 'Other income'}${it.gross > 0 && it.type && it.type !== 'employment' ? ` <small class="tx-rate">${it.type}</small>` : ''}</td><td class="num">${fmtN(it.gross)}</td></tr>`).join('')}
          <tr class="tw-total"><td>Total taxable income</td><td class="num">${fmtN(totalTaxable_)}</td></tr>
        </table>
      </div>
      <div class="tw-step">
        <div class="tw-step-title">Step 2 — Personal allowance</div>
        ${step2Html_}
      </div>
      <div class="tw-step">
        <div class="tw-step-title">Step 3 — Tax by income source (stacking order)</div>
        <p class="tw-step-note">UK income stacking order (ITA 2007 s23): pension &amp; employment fill the lowest bands first, then property, then savings, then dividends — each at their applicable rate schedule. Each row shows the slice of income falling in that band × the applicable rate.</p>
        <table class="tw-table">
          ${step3Rows_}
          <tr class="tw-total"><td>Total income tax</td><td class="num">${fmtA(totalTax_)}</td></tr>
        </table>
      </div>
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
      ${personWorkings('You', primaryDWAnn, primaryTFrac, spGrossAnn, hasStatePension, otherItems, cumulPrimaryTaxFreeUsed, primTc, d.calYear, r.p?.taxFreeMode || 'ufpls')}
      ${hasPartner ? personWorkings('Partner', partnerDWAnn, partnerTFrac, partnerSpGrossAnn, hasPartnerSP, partnerOtherItems, cumulPartnerTaxFreeUsed, partnTc, d.calYear, r.p?.partner?.taxFreeMode || 'ufpls') : ''}
    </div>`;

  const tableSection = (title, cols, tbody, tGross, tTax, tNet) => `
    <div class="tw-table-title">${title}</div>
    <table class="tax-summary-table">
      <thead>
        <tr>
          <th style="text-align:left">Income Source</th>
          <th class="num">Gross ${cols}</th>
          <th class="num">Tax ${cols}</th>
          <th class="num">Net ${cols}</th>
        </tr>
      </thead>
      <tbody>
        ${tbody}
        <tr class="tax-total-row">
          <td>Total Household</td>
          <td class="num">${fmtGBP(tGross)}</td>
          <td class="num">${fmtGBP(tTax)}</td>
          <td class="num">${fmtGBP(tNet)}</td>
        </tr>
      </tbody>
    </table>`;

  contentEl.innerHTML =
    tableSection('Annual Breakdown', '/yr', annualSummaryTbody, annualTotalGross, annualTotalTax, annualTotalNet) +
    tableSection('Monthly Breakdown', '/mo', summaryTbody, totalGross, totalTax, totalNet) +
    workingsHtml;
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
        ...(r.p?.dbPensions?.length || r.p?.partner?.dbPensions?.length ? [{ label: 'DB Pension', data: makeSeries('db'), backgroundColor: '#7c3aed', stack: 'a' }] : []),
        { label: 'State Pension', data: makeSeries('sp'), backgroundColor: '#16a34a', stack: 'a' },
        ...(r.p?.partner ? [{ label: 'Partner SP', data: makeSeries('partnerSp'), backgroundColor: '#86efac', stack: 'a' }] : []),
        ...(r.p?.partner && (r.p.partner.incomes?.length || r.p.partner.dbPensions?.length) ? [{ label: 'Partner Income', data: makeSeries('partnerOther'), backgroundColor: '#f59e0b', stack: 'a' }] : []),
        { label: 'Other Income', data: makeSeries('other'), backgroundColor: '#d97706', stack: 'a' },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: textColor() } },
        tooltip: {
          callbacks: {
            title: (items) => {
              const total = items.reduce((s, i) => s + (i.raw || 0), 0);
              return `Age ${items[0].label}  —  Total: ${fmtGBP(total)}`;
            }
          }
        }
      },
      scales: {
        x: { stacked: true, ticks: { color: textColor(), maxTicksLimit: 12 }, grid: { color: gridColor() }, title: { display: true, text: 'Age', color: textColor() } },
        y: { stacked: true, ticks: { color: textColor(), callback: v => '£' + fmt(v) }, grid: { color: gridColor() }, title: { display: true, text: useToday ? "Net Monthly Income (Today's £)" : 'Net Monthly Income (Nominal £)', color: textColor() } }
      }
    }
  });
}

function renderAnnualIncomeChart(r) {
  destroyChart('annualincome');
  const ctx = document.getElementById('chart-annualincome').getContext('2d');
  const useToday = isTodayMoney();
  const p = r.p;

  const { chartAges, incActualsByAge, todayIdx, showTodayLine } = buildActualsChartData(r);

  // Simulation: null before retirementAge or before currentAge
  const simValues = chartAges.map(a => {
    if (a < r.ages[0] || a < p.currentAge) return null;
    const i = a - r.ages[0];
    if (i >= r.annualIncomeData.length) return null;
    return useToday ? r.annualIncomeData[i].netReal : r.annualIncomeData[i].netNom;
  });
  const simLabel = useToday ? "Total Net /mo — Today's £ (real)" : 'Total Net /mo — Nominal (actual £)';

  // Income actuals: annual gross ÷ 12 → monthly; sparse
  const hasIncomeActuals = Object.keys(incActualsByAge).length > 0;
  const incActualsValues = chartAges.map(a => incActualsByAge[a] != null ? incActualsByAge[a] / 12 : null);

  const overlayPlugin = {
    id: 'overlay',
    afterDraw(chart) {
      if (!showTodayLine) return;
      const { ctx: c, scales: { x, y } } = chart;
      const xPx = x.getPixelForValue(todayIdx);
      c.save(); c.strokeStyle = '#2563eb'; c.lineWidth = 1.5; c.setLineDash([4, 4]);
      c.beginPath(); c.moveTo(xPx, y.top); c.lineTo(xPx, y.bottom); c.stroke();
      c.fillStyle = '#2563eb'; c.font = '11px system-ui,sans-serif';
      c.textAlign = 'left'; c.fillText('Today', xPx + 4, y.top + 14); c.restore();
    }
  };

  const datasets = [
    { label: simLabel, data: simValues, borderColor: '#2563eb', backgroundColor: useToday ? 'rgba(37,99,235,0.08)' : 'transparent', fill: useToday, tension: 0.3, pointRadius: 0, borderWidth: 2, spanGaps: false },
  ];
  if (hasIncomeActuals) {
    datasets.push({ label: 'Actual income /mo', data: incActualsValues, borderColor: '#16a34a', backgroundColor: '#16a34a', showLine: true, tension: 0.2, pointRadius: 5, pointHoverRadius: 7, borderWidth: 2, spanGaps: false, fill: false });
  }

  charts['annualincome'] = new Chart(ctx, {
    type: 'line',
    plugins: [overlayPlugin],
    data: { labels: chartAges, datasets },
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

// ── Historical Replay ─────────────────────────────────────────────────────

/**
 * Populate the start-year dropdown with all 126 historical years, labelling
 * notable ones from HIST_YEAR_EVENTS. Preserves the current selection if valid.
 */
function populateHistReplayDropdown() {
  const sel = document.getElementById('hist-replay-year');
  if (!sel) return;
  const currentVal = sel.value;
  sel.innerHTML = '';
  for (let y = 1900; y <= 2025; y++) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = HIST_YEAR_EVENTS[y] ? `${y} — ${HIST_YEAR_EVENTS[y]}` : `${y}`;
    sel.appendChild(opt);
  }
  sel.value = (currentVal && +currentVal >= 1900 && +currentVal <= 2025) ? currentVal : '2000';
}

/**
 * Runs a sequential historical-return projection starting from `startYear`.
 * The weighted equity/bond blend is derived from each pot's equityPct, weighted
 * by the pot's current value — giving the correct blended return for the user's
 * actual portfolio mix.
 *
 * Returns { detPotByYear, detCashBalByYear, hrReturnData } where:
 *   hrReturnData[yi] = { histCalYear, blendedPct, eventLabel }  ← return experienced *during* year yi
 *   hrReturnData[years] = { histCalYear: null, blendedPct: null, eventLabel: null }  ← final balance row
 */
function runHistoricalReplayProjection(r, startYear) {
  const p = r.p;
  const years = p.endAge - p.retirementAge;
  if (years <= 0) return null;

  const startIdx = startYear - 1900;
  const histLen = HIST_EQUITY_RETURNS.length;
  const yearsToRetirement = Math.max(0, p.retirementAge - (p.currentAgeFrac ?? p.currentAge));
  const baseInflFactor = 1 + p.inflation / 100;

  // Weighted equity fraction: each pot's contribution is proportional to its current value
  const allPots = [...(p.pots || []), ...(p.partner?.pots || [])];
  const totalVal = allPots.reduce((s, pot) => s + (pot.value || 0), 0);
  const equityW = totalVal > 0
    ? allPots.reduce((s, pot) => s + ((pot.value || 0) / totalVal) * ((pot.equityPct || 80) / 100), 0)
    : 0.8;

  const allCashPots = p.cashPots || [];
  const runCashBals = r.startCashPotVals ? Float64Array.from(r.startCashPotVals) : new Float64Array(0);

  const detPotByYear = new Float64Array(years + 1);
  const detCashBalByYear = new Float64Array(years + 1);
  const hrReturnData = new Array(years + 1);

  detPotByYear[0] = r.startPensionPot;
  detCashBalByYear[0] = runCashBals.reduce((s, v) => s + v, 0);
  // Final balance row has no further return to show
  hrReturnData[years] = { histCalYear: null, blendedPct: null, eventLabel: null };

  for (let y = 0; y < years; y++) {
    const histIdx = (startIdx + y) % histLen;
    const histCalYear = 1900 + histIdx;
    const eqRet = HIST_EQUITY_RETURNS[histIdx];
    const bdRet = HIST_BONDS_RETURNS[histIdx];
    const blendedPct = equityW * eqRet + (1 - equityW) * bdRet;
    const ret = 1 + blendedPct / 100;
    const eventLabel = HIST_YEAR_EVENTS[histCalYear] || null;

    // hrReturnData[y] = the return EXPERIENCED during year y of retirement
    hrReturnData[y] = { histCalYear, blendedPct, eventLabel };

    const age = p.retirementAge + y;
    const ci = Math.pow(baseInflFactor, y);

    // Cash pot growth each year
    for (let ci2 = 0; ci2 < runCashBals.length; ci2++) {
      runCashBals[ci2] *= (1 + allCashPots[ci2].interestPct / 100);
    }

    const combined = detPotByYear[y] + runCashBals.reduce((s, v) => s + v, 0);
    if (combined <= 0) {
      detPotByYear[y + 1] = 0;
      detCashBalByYear[y + 1] = 0;
      continue;
    }

    const pensionAfterGrowth = detPotByYear[y] * ret;

    const hasSP = age >= p.spAge;
    const spNom = hasSP ? p.sp * ci : 0;
    const partnerAge = p.partner ? p.partner.currentAge + (age - p.currentAge) : null;
    const partnerSpNom = (p.partner && partnerAge >= p.partner.spAge) ? p.partner.sp * ci : 0;
    const ciFromNow = Math.pow(baseInflFactor, yearsToRetirement + y);
    const partnerRetired = !!(p.partner && partnerAge >= p.partner.retirementAge);
    const ageCtxHR = { currentAge: age, retirementAge: p.retirementAge, yearsToRetirement, baseInflFactor };
    const otherGross = calcOtherIncomesNet(p.incomes || [], ciFromNow, ageCtxHR).grossTotal;
    const partnerOtherGross = (p.partner?.incomes?.length && partnerRetired)
      ? calcOtherIncomesNet(p.partner.incomes, ciFromNow, { currentAge: partnerAge, retirementAge: p.partner.retirementAge, yearsToRetirement: Math.max(0, p.partner.retirementAge - (p.partner.currentAgeFrac ?? p.partner.currentAge)), baseInflFactor }).grossTotal : 0;
    const totalOtherGross = otherGross + partnerOtherGross;
    const inflFactor = p.drawdownInflation ? ci : 1.0;
    const baseTarget = p.drawdown * inflFactor;
    const targetNominal = age >= p.reductionAge
      ? Math.max(0, (baseTarget + totalOtherGross) * (1 - p.reductionPct / 100) - totalOtherGross)
      : baseTarget;
    const grossNeeded = Math.max(0, targetNominal - spNom - partnerSpNom);

    const notionalTc = calcPensionTax(grossNeeded, spNom, hasSP, r.taxFreeFrac || 0.25);
    const netTarget = notionalTc.pensionNet;

    let cashRemaining = netTarget;
    for (let ci2 = 0; ci2 < runCashBals.length && cashRemaining > 0; ci2++) {
      const take = Math.min(runCashBals[ci2], cashRemaining);
      runCashBals[ci2] -= take;
      cashRemaining -= take;
    }
    const cashTaken = netTarget - cashRemaining;
    const remainingNet = Math.max(0, netTarget - cashTaken);
    const pensionWithdrawal = netTarget > 0 ? remainingNet * (grossNeeded / netTarget) : 0;

    detPotByYear[y + 1] = Math.max(0, pensionAfterGrowth - pensionWithdrawal);
    detCashBalByYear[y + 1] = runCashBals.reduce((s, v) => s + v, 0);
  }

  return { detPotByYear, detCashBalByYear, hrReturnData };
}

// ── Sequence of Returns Risk projection ───────────────────────────────────
// Runs the same deterministic annual loop as runHistoricalReplayProjection
// but substitutes a synthetic return sequence: crashPct for the first
// crashYears of retirement, then r.p.returnPct for the remainder.
// Guardrail logic is honoured when p.guardrails is true.
function runSorrProjection(r, crashPct, crashYears) {
  const p = r.p;
  const years = p.endAge - p.retirementAge;
  if (years <= 0) return null;

  const baseInflFactor = 1 + p.inflation / 100;
  const yearsToRetirement = Math.max(0, p.retirementAge - (p.currentAgeFrac ?? p.currentAge));

  const allCashPots = p.cashPots || [];
  const runCashBals = r.startCashPotVals ? Float64Array.from(r.startCashPotVals) : new Float64Array(0);

  const detPotByYear = new Float64Array(years + 1);
  const detCashBalByYear = new Float64Array(years + 1);
  const sorrYearData = new Array(years + 1);

  detPotByYear[0] = r.startPensionPot;
  detCashBalByYear[0] = runCashBals.reduce((s, v) => s + v, 0);
  sorrYearData[years] = { returnPct: null, guardrailFired: false };

  const startPension = r.startPensionPot;

  for (let y = 0; y < years; y++) {
    const annualReturnPct = y < crashYears ? crashPct : p.returnPct;
    const ret = 1 + annualReturnPct / 100;

    const age = p.retirementAge + y;
    const ci = Math.pow(baseInflFactor, y);
    const ciFromNow = Math.pow(baseInflFactor, yearsToRetirement + y);

    // Cash pot growth
    for (let ci2 = 0; ci2 < runCashBals.length; ci2++) {
      runCashBals[ci2] *= (1 + allCashPots[ci2].interestPct / 100);
    }

    const combined = detPotByYear[y] + runCashBals.reduce((s, v) => s + v, 0);
    if (combined <= 0) {
      detPotByYear[y + 1] = 0;
      detCashBalByYear[y + 1] = 0;
      sorrYearData[y] = { returnPct: annualReturnPct, guardrailFired: false, pensionWithdrawal: 0, potReturn: 0 };
      continue;
    }

    const pensionAfterGrowth = detPotByYear[y] * ret;
    const potReturn = detPotByYear[y] * annualReturnPct / 100;

    // Guardrail: pot dropped >20% below retirement value — apply 10% reduction this year
    const guardrailFired = p.guardrails && y > 0 && detPotByYear[y] < startPension * 0.80;
    const guardrailFactor = guardrailFired ? 0.90 : 1.0;

    sorrYearData[y] = { returnPct: annualReturnPct, guardrailFired, potReturn };
    const hasSP = age >= p.spAge;
    const spNom = hasSP ? p.sp * ci : 0;
    const partnerAge = p.partner ? p.partner.currentAge + (age - p.currentAge) : null;
    const partnerSpNom = (p.partner && partnerAge >= p.partner.spAge) ? p.partner.sp * ci : 0;
    const partnerRetired = !!(p.partner && partnerAge >= p.partner.retirementAge);
    const ageCtx = { currentAge: age, retirementAge: p.retirementAge, yearsToRetirement, baseInflFactor };
    const otherGross = calcOtherIncomesNet(p.incomes || [], ciFromNow, ageCtx).grossTotal;
    const partnerOtherGross = (p.partner?.incomes?.length && partnerRetired)
      ? calcOtherIncomesNet(p.partner.incomes, ciFromNow, { currentAge: partnerAge, retirementAge: p.partner.retirementAge, yearsToRetirement: Math.max(0, p.partner.retirementAge - (p.partner.currentAgeFrac ?? p.partner.currentAge)), baseInflFactor }).grossTotal : 0;
    const totalOtherGross = otherGross + partnerOtherGross;

    const inflFactor = p.drawdownInflation ? ci : 1.0;
    const baseTarget = p.drawdown * inflFactor * guardrailFactor;
    const targetNominal = age >= p.reductionAge
      ? Math.max(0, (baseTarget + totalOtherGross) * (1 - p.reductionPct / 100) - totalOtherGross)
      : baseTarget;
    const grossNeeded = Math.max(0, targetNominal - spNom - partnerSpNom);

    const notionalTc = calcPensionTax(grossNeeded, spNom, hasSP, r.taxFreeFrac || 0.25);
    const netTarget = notionalTc.pensionNet;

    let cashRemaining = netTarget;
    for (let ci2 = 0; ci2 < runCashBals.length && cashRemaining > 0; ci2++) {
      const take = Math.min(runCashBals[ci2], cashRemaining);
      runCashBals[ci2] -= take;
      cashRemaining -= take;
    }
    const cashTaken = netTarget - cashRemaining;
    const remainingNet = Math.max(0, netTarget - cashTaken);
    const pensionWithdrawal = netTarget > 0 ? remainingNet * (grossNeeded / netTarget) : 0;

    detPotByYear[y + 1] = Math.max(0, pensionAfterGrowth - pensionWithdrawal);
    detCashBalByYear[y + 1] = runCashBals.reduce((s, v) => s + v, 0);
    sorrYearData[y].pensionWithdrawal = pensionWithdrawal;
  }

  return { detPotByYear, detCashBalByYear, sorrYearData };
}

function renderSorrSummary(sorrResult, p, r) {
  const summaryEl = document.getElementById('sorr-summary');
  const tbodyEl = document.getElementById('sorr-tbody');
  const controlsEl = document.getElementById('sorr-controls');
  if (!summaryEl) return;

  if (!sorrResult) {
    summaryEl.innerHTML = '';
    if (tbodyEl) tbodyEl.innerHTML = '';
    return;
  }

  const useToday = isTodayMoney();
  const baseInflFactor = 1 + (p?.inflation || 0) / 100;
  const yearsToRetirement = Math.max(0, p.retirementAge - (p.currentAgeFrac ?? p.currentAge));
  const deflator = y => Math.pow(1 / baseInflFactor, yearsToRetirement + y);
  const years = p.endAge - p.retirementAge;

  // Find when/if pot is depleted
  let depletedAge = null;
  for (let y = 0; y <= years; y++) {
    const combined = (sorrResult.detPotByYear[y] || 0) + (sorrResult.detCashBalByYear[y] || 0);
    if (combined <= 0 && y > 0) {
      depletedAge = p.retirementAge + y;
      break;
    }
  }

  // Find first guardrail fire year
  let firstGuardrailAge = null;
  for (let y = 0; y < years; y++) {
    if (sorrResult.sorrYearData[y]?.guardrailFired) {
      firstGuardrailAge = p.retirementAge + y;
      break;
    }
  }

  // Final surviving balance
  const finalPot = (sorrResult.detPotByYear[years] || 0) + (sorrResult.detCashBalByYear[years] || 0);
  const finalVal = useToday ? finalPot * deflator(years) : finalPot;

  let summaryHtml = '<div style="display:flex;flex-wrap:wrap;gap:10px">';
  if (depletedAge) {
    summaryHtml += `<div style="padding:8px 12px;border-radius:6px;background:rgba(220,38,38,0.12);border:1px solid rgba(220,38,38,0.3);font-size:0.82rem"><strong style="color:#dc2626">Pot depleted at age ${depletedAge}</strong><br><span style="color:var(--text2)">${depletedAge - p.retirementAge} years into retirement — ${p.endAge - depletedAge} years before target end age</span></div>`;
  } else {
    summaryHtml += `<div style="padding:8px 12px;border-radius:6px;background:rgba(22,163,74,0.1);border:1px solid rgba(22,163,74,0.3);font-size:0.82rem"><strong style="color:#16a34a">Pot survives to age ${p.endAge}</strong><br><span style="color:var(--text2)">Final balance: ${fmtGBP(finalVal)}${useToday ? ' (today\'s money)' : ''}</span></div>`;
  }
  if (firstGuardrailAge) {
    summaryHtml += `<div style="padding:8px 12px;border-radius:6px;background:rgba(217,119,6,0.1);border:1px solid rgba(217,119,6,0.3);font-size:0.82rem"><strong style="color:#d97706">Guardrail fires at age ${firstGuardrailAge}</strong><br><span style="color:var(--text2)">10% income reduction applied</span></div>`;
  } else if (p.guardrails) {
    summaryHtml += `<div style="padding:8px 12px;border-radius:6px;background:rgba(37,99,235,0.08);border:1px solid rgba(37,99,235,0.2);font-size:0.82rem"><span style="color:var(--text2)">Guardrails not triggered</span></div>`;
  }
  summaryHtml += '</div>';
  summaryEl.innerHTML = summaryHtml;

  // Year-by-year table
  if (!tbodyEl) return;
  let rows = '';
  for (let y = 0; y <= years; y++) {
    const age = p.retirementAge + y;
    const combined = (sorrResult.detPotByYear[y] || 0) + (sorrResult.detCashBalByYear[y] || 0);
    const dispVal = useToday ? combined * deflator(y) : combined;
    const yd = sorrResult.sorrYearData[y];
    const retPct = yd?.returnPct != null ? (yd.returnPct > 0 ? '+' : '') + yd.returnPct.toFixed(1) + '%' : '—';
    const grFlag = yd?.guardrailFired ? '<span style="color:#d97706;font-weight:600">⚠ −10%</span>' : '';
    const depleted = combined <= 0 && y > 0;
    const drawdown = yd?.pensionWithdrawal != null ? (useToday ? yd.pensionWithdrawal * deflator(y) : yd.pensionWithdrawal) : null;
    const drawdownCell = drawdown != null && drawdown > 0 ? fmtGBP(drawdown) : (y === years ? '—' : '£0');
    const potReturnRaw = yd?.potReturn != null ? (useToday ? yd.potReturn * deflator(y) : yd.potReturn) : null;
    const potReturnCell = potReturnRaw != null ? `<span style="color:${potReturnRaw >= 0 ? '#16a34a' : '#dc2626'}">${potReturnRaw >= 0 ? '+' : ''}${fmtGBP(potReturnRaw)}</span>` : '—';
    rows += `<tr${depleted ? ' style="color:rgba(220,38,38,0.8)"' : ''}>
      <td style="text-align:left">${age}</td>
      <td>${retPct}</td>
      <td>${potReturnCell}</td>
      <td>${depleted ? '£0 (depleted)' : fmtGBP(dispVal)}</td>
      <td>${drawdownCell}</td>
      <td>${grFlag}</td>
    </tr>`;
  }
  tbodyEl.innerHTML = rows;
}

function renderHistoricalReplayChart(hrResult) {  if (!chartAvailable()) return;
  destroyChart('historicalreplay');
  const chartEl = document.getElementById('chart-historicalreplay');
  if (!chartEl) return;
  const ctx = chartEl.getContext('2d');
  const useToday = isTodayMoney();
  const baseInflFactor = 1 + (hrResult.p?.inflation || 0) / 100;
  const yearsToRetirement = Math.max(0, hrResult.p.retirementAge - (hrResult.p.currentAgeFrac ?? hrResult.p.currentAge));
  const deflator = i => Math.pow(1 / baseInflFactor, yearsToRetirement + i);

  const potData = Array.from(hrResult.detPotByYear).map((v, i) => useToday ? v * deflator(i) : v);
  const hrReturnData = hrResult.hrReturnData;
  const spAgeIdx = hrResult.ages.indexOf(hrResult.p.spAge);

  // Collect notable events (only years with an eventLabel) for chart annotations
  const notableEvents = [];
  hrReturnData.forEach((d, yi) => {
    if (d && d.eventLabel) notableEvents.push({ yi, histCalYear: d.histCalYear, label: d.eventLabel });
  });

  const overlayPlugin = {
    id: 'hrOverlay',
    afterDraw(chart) {
      const { ctx: c, scales: { x, y } } = chart;
      // State Pension line (amber, matches rest of app)
      if (spAgeIdx >= 0) {
        const xPx = x.getPixelForValue(spAgeIdx);
        c.save();
        c.strokeStyle = '#d97706';
        c.lineWidth = 1.5;
        c.setLineDash([6, 4]);
        c.beginPath(); c.moveTo(xPx, y.top); c.lineTo(xPx, y.bottom); c.stroke();
        c.fillStyle = '#d97706';
        c.font = '10px system-ui,sans-serif';
        c.textAlign = 'left';
        c.fillText('SP', xPx + 3, y.top + 12);
        c.restore();
      }
      // Notable event lines (red dashed) with year label rotated at top
      notableEvents.forEach(ev => {
        const xPx = x.getPixelForValue(ev.yi);
        c.save();
        c.strokeStyle = 'rgba(220,38,38,0.55)';
        c.lineWidth = 1;
        c.setLineDash([4, 3]);
        c.beginPath(); c.moveTo(xPx, y.top); c.lineTo(xPx, y.bottom); c.stroke();
        c.fillStyle = 'rgba(185,28,28,0.85)';
        c.font = 'bold 9px system-ui,sans-serif';
        c.textAlign = 'center';
        c.translate(xPx, y.top + 42);
        c.rotate(-Math.PI / 2);
        c.fillText(String(ev.histCalYear), 0, 0);
        c.restore();
      });
    }
  };

  charts['historicalreplay'] = new Chart(ctx, {
    type: 'line',
    plugins: [overlayPlugin],
    data: {
      labels: hrResult.ages,
      datasets: [
        {
          label: useToday ? "Pot Balance (Today's £)" : 'Pot Balance (Nominal)',
          data: potData,
          borderColor: 'rgba(37,99,235,1)',
          backgroundColor: 'rgba(37,99,235,0.08)',
          fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2,
        },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: textColor(), font: { size: 11 } } },
        tooltip: {
          callbacks: {
            afterBody(items) {
              if (!items.length) return [];
              const yi = items[0].dataIndex;
              const hd = hrReturnData[yi];
              if (!hd || hd.histCalYear == null) return [];
              const lines = [];
              if (hd.blendedPct != null) {
                const sign = hd.blendedPct >= 0 ? '+' : '';
                lines.push(`Hist. year: ${hd.histCalYear}  (${sign}${hd.blendedPct.toFixed(1)}%)`);
              }
              if (hd.eventLabel) lines.push(`📌 ${hd.eventLabel}`);
              return lines;
            }
          }
        }
      },
      scales: {
        x: { ticks: { color: textColor(), maxTicksLimit: 12 }, grid: { color: gridColor() }, title: { display: true, text: 'Age', color: textColor() } },
        y: { ticks: { color: textColor(), callback: v => fmtAxisGBP(v) }, grid: { color: gridColor() }, title: { display: true, text: useToday ? "Pot Balance (Today's £)" : 'Pot Balance (Nominal £)', color: textColor() } }
      }
    }
  });
}

function renderHistoricalReplayTable(hrResult) {
  const tbody = document.getElementById('hist-replay-tbody');
  if (!tbody) return;
  const isToday = isTodayMoney();
  const hasPartner = !!hrResult.p?.partner;

  ['hr-th-partner-sp', 'hr-th-partner-other'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = hasPartner ? '' : 'none';
  });

  function cell(nom, real) {
    const v = isToday ? real : nom;
    return `<td style="text-align:right">${fmtGBP(v)}</td>`;
  }
  function incomeCell(netNom, netReal, grossNom, grossReal, taxNom, taxReal, hidden = false) {
    const net   = isToday ? netReal   : netNom;
    const gross = isToday ? grossReal : grossNom;
    const tax   = isToday ? taxReal   : taxNom;
    const style = hidden ? 'text-align:right;display:none' : 'text-align:right';
    return `<td style="${style}">${fmtGBP(net)}<span class="ann-sub">Gross: ${fmtGBP(gross)}</span><span class="ann-sub ann-tax">Tax: ${fmtGBP(tax)}</span></td>`;
  }
  function growthCell(nom, real) {
    const v = isToday ? real : nom;
    const str = v >= 0 ? fmtGBP(v) : `<span style="color:var(--red)">${fmtGBP(v)}</span>`;
    return `<td style="text-align:right">${str}</td>`;
  }

  const hrReturnData = hrResult.hrReturnData;

  tbody.innerHTML = hrResult.annualIncomeData.map((d, yi) => {
    const hd = hrReturnData[yi] || {};
    const hasEvent = !!hd.eventLabel;

    let cls = '';
    if (d.guardrailActive) cls = 'guardrail-row';
    else if (d.isSpStart) cls = 'sp-start-row';
    else if (d.isPartnerSpStart) cls = 'partner-sp-start-row';

    const ageDisplay = hasPartner
      ? `${d.age}<span style="color:var(--text2)">/${d.partnerAge}</span>`
      : `${d.age}`;
    const ageLabel = `${ageDisplay}<br><span style="font-size:0.72rem;color:var(--text2)">${d.calYear}</span>`;

    // Historical return cell
    let retCell;
    if (hd.histCalYear != null && hd.blendedPct != null) {
      const pct = hd.blendedPct;
      const pctColor = pct >= 0 ? 'var(--green,#16a34a)' : 'var(--red,#dc2626)';
      const pctStr = `<span style="color:${pctColor};font-weight:600">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</span>`;
      const eventBadge = hasEvent
        ? `<span class="ann-sub" style="color:var(--amber,#d97706);font-weight:600">📌 ${hd.eventLabel}</span>`
        : '';
      retCell = `<td style="text-align:right;font-size:0.82rem">${hd.histCalYear}<br>${pctStr}${eventBadge}</td>`;
    } else {
      retCell = `<td style="text-align:right;font-size:0.82rem;color:var(--text2)">—</td>`;
    }

    const rowStyle = hasEvent ? ' style="background:rgba(251,191,36,0.09)"' : '';
    return `<tr class="${cls}"${rowStyle}>
      <td>${ageLabel}</td>
      ${retCell}
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
      ${growthCell(d.netPotChangeNom, d.netPotChangeReal)}
      ${cell(d.potBalNom, d.potBalReal)}
    </tr>`;
  }).join('');
}

function renderHistoricalReplayTab(r) {
  if (!r) return;
  const sel = document.getElementById('hist-replay-year');
  if (!sel) return;
  const startYear = +sel.value || 2000;
  const proj = runHistoricalReplayProjection(r, startYear);
  if (!proj) return;

  const hrResult = Object.assign({}, r, {
    detPotByYear: proj.detPotByYear,
    detCashBalByYear: proj.detCashBalByYear,
    hrReturnData: proj.hrReturnData,
  });
  hrResult.annualIncomeData = buildAnnualIncomeData(hrResult);

  renderHistoricalReplayChart(hrResult);
  renderHistoricalReplayTable(hrResult);

  const note = document.getElementById('hist-replay-note');
  if (note) {
    const endYear = startYear + r.ages.length - 2;
    const wrapped = endYear > 2025;
    note.textContent = `Replaying actual market returns from ${startYear}–${endYear} through your ${r.ages.length - 1}-year retirement`
      + (wrapped ? `. Returns after 2025 wrap to historical data from 1900 onwards.` : `.`);
  }
}

// ── Actuals Tab ───────────────────────────────────────────────────────────
function renderActualsTab(r) {
  const hasEvents = actualsEvents.length > 0;
  document.getElementById('actuals-empty-note').style.display = hasEvents ? 'none' : '';
  document.getElementById('actuals-cards').style.display      = hasEvents ? ''     : 'none';
  const badge = document.getElementById('recalibrated-badge');
  if (badge) badge.style.display = r?._recalibrated ? '' : 'none';
  if (!hasEvents) return;

  const currentYear = new Date().getFullYear();
  const baseP   = getParams();          // un-recalibrated settings values
  const allPots = baseP.pots || [];
  const returnPct = r.returnPct ?? 5;
  const useToday  = isTodayMoney();
  const baseInfl  = 1 + (baseP.inflation || 0) / 100;

  function deflate(val, dateStr) {
    if (!useToday) return val;
    return val * Math.pow(1 / baseInfl, parseInt(dateStr, 10) - currentYear);
  }

  // ── Build per-date snapshot totals ────────────────────────────────────
  // For every unique snapshot date: each pot gets its latest journaled value
  // up to that date, falling back to the settings value if none exists yet.
  const allSnapshotDates = [...new Set(
    actualsEvents
      .filter(e => e.type === 'pot_valuation' && e.date)
      .map(e => e.date)
  )].sort();

  const potEvents = actualsEvents
    .filter(e => e.type === 'pot_valuation' && e.date && e.amount != null)
    .sort((a, b) => a.date.localeCompare(b.date));

  const snapshotData = allSnapshotDates.map(date => {
    const perPot = allPots.map(pot => {
      // Latest journaled event for this pot up to and including this date
      const latest = potEvents
        .filter(e => e.targetUuid === pot.uuid && e.date <= date)
        .at(-1);
      const value = latest ? Number(latest.amount) : pot.value;
      return { name: pot.name, value, isActual: !!latest };
    });
    return { date, total: perPot.reduce((s, p) => s + p.value, 0), perPot };
  });

  // ── Summary cards ─────────────────────────────────────────────────────
  if (snapshotData.length > 0) {
    const latest     = snapshotData.at(-1);
    const latestVal  = latest.total;
    const latestYear = parseInt(latest.date, 10);
    const ageAtLatest = baseP.currentAge + (latestYear - currentYear);
    const forecastIdx = r.ages.indexOf(ageAtLatest);
    // Compare against the un-recalibrated forecast so divergence is meaningful
    const forecastVal = forecastIdx >= 0 ? (r.detPotByYear?.[forecastIdx] || 0) : null;
    const divergence  = forecastVal != null ? latestVal - forecastVal : null;

    document.getElementById('ac-latest-val').textContent  = fmtGBP(latestVal);
    document.getElementById('ac-latest-date').textContent = latest.date;

    if (forecastVal != null && !r._recalibrated) {
      document.getElementById('ac-forecast-val').textContent = fmtGBP(forecastVal);
      const divEl = document.getElementById('ac-divergence');
      const subEl = document.getElementById('ac-divergence-sub');
      const pct   = forecastVal > 0 ? ((divergence / forecastVal) * 100).toFixed(1) : '—';
      divEl.textContent = (divergence >= 0 ? '+' : '') + fmtGBP(divergence);
      divEl.className   = 'card-value ' + (divergence >= 0 ? 'green' : 'red');
      subEl.textContent = `${Math.abs(+pct)}% ${divergence >= 0 ? 'ahead of' : 'behind'} original forecast`;
    } else {
      document.getElementById('ac-forecast-val').textContent = r._recalibrated ? '(recalibrated)' : '—';
      document.getElementById('ac-divergence').textContent   = '—';
      document.getElementById('ac-divergence-sub').textContent = r._recalibrated
        ? 'turn off recalibration to compare'
        : 'age outside projection range';
    }
  }

  // ── Build recalibrated forecast (always, regardless of toggle) ────────
  // Pots: latest actual per pot (or settings value if no actuals for that pot)
  const rp = applyActualsRecalibration(baseP, actualsEvents);
  const yearsToRetirement = Math.max(0, rp.retirementAge - (rp.currentAgeFrac ?? rp.currentAge));
  const retirementYear = currentYear + Math.round(yearsToRetirement);

  // Per-pot starting values from the last snapshot (latest actual per pot, or settings fallback)
  const lastSnap = snapshotData.at(-1);
  const potStartVals = allPots.map((pot, i) => ({
    value:        lastSnap ? (lastSnap.perPot[i]?.value ?? pot.value) : pot.value,
    annualContrib: pot.annualContrib || 0,
  }));

  const monthlyRet  = Math.pow(1 + returnPct / 100, 1 / 12);
  const forecastPoints = [];  // { date: 'YYYY-MM-DD', y: nominal }

  // Pre-retirement: monthly from the month after the last snapshot through to retirement year.
  // Contributions are applied each month (annualContrib / 12).
  const curVals     = potStartVals.map(p => p.value);
  const lastDateObj = lastSnap ? new Date(lastSnap.date) : new Date();
  let cur = new Date(lastDateObj.getFullYear(), lastDateObj.getMonth() + 1, 1);
  while (cur.getFullYear() < retirementYear) {
    for (let i = 0; i < curVals.length; i++) {
      curVals[i] = curVals[i] * monthlyRet + potStartVals[i].annualContrib / 12;
    }
    const mm = String(cur.getMonth() + 1).padStart(2, '0');
    forecastPoints.push({ date: `${cur.getFullYear()}-${mm}-01`, y: curVals.reduce((s, v) => s + v, 0) });
    cur.setMonth(cur.getMonth() + 1);
  }

  // Post-retirement: deterministic projection (annual) from recalibrated starting values
  const det = runDeterministicProjection({ ...rp, taxFreeFrac: r.taxFreeFrac ?? 0.25 }, returnPct);
  if (det) {
    for (let i = 0; i < det.detPotByYear.length; i++) {
      forecastPoints.push({ date: `${retirementYear + i}-01-01`, y: det.detPotByYear[i] });
    }
  }

  // ── Chart ─────────────────────────────────────────────────────────────
  if (chartAvailable()) {
    destroyChart('actuals');
    const chartEl = document.getElementById('chart-actuals');
    if (!chartEl) return;
    const ctx = chartEl.getContext('2d');

    const lastActualDate  = allSnapshotDates.at(-1) || '';
    const forecastDates   = forecastPoints.map(p => p.date).filter(d => d > lastActualDate);
    const forecastDateSet = new Set(forecastDates);
    const allLabels       = [...allSnapshotDates, ...forecastDates];

    // Actuals line: value at each snapshot date, null elsewhere
    const actualsDataArr = allLabels.map((d, i) =>
      i < allSnapshotDates.length ? deflate(snapshotData[i].total, d) : null
    );

    // Forecast line: anchored at last actual date for a smooth join, then forecast dates
    const forecastMap     = Object.fromEntries(forecastPoints.map(p => [p.date, p.y]));
    const lastActualDate2 = allSnapshotDates.at(-1);
    const forecastDataArr = allLabels.map((d, i) => {
      if (d === lastActualDate2) return deflate(snapshotData.at(-1).total, d);  // anchor
      if (forecastDateSet.has(d)) return deflate(forecastMap[d], d);
      return null;
    });

    const overlayPlugin = {
      id: 'overlay',
      afterDraw(chart) {
        const { ctx: c, scales: { x, y } } = chart;
        const retIdx = allLabels.indexOf(`${retirementYear}-01-01`);
        if (retIdx >= 0) {
          const xPx = x.getPixelForValue(retIdx);
          c.save(); c.strokeStyle = '#d97706'; c.lineWidth = 1.5; c.setLineDash([6, 4]);
          c.beginPath(); c.moveTo(xPx, y.top); c.lineTo(xPx, y.bottom); c.stroke();
          c.fillStyle = '#d97706'; c.font = '11px system-ui,sans-serif';
          c.textAlign = 'left'; c.fillText('Retirement', xPx + 4, y.top + 14); c.restore();
        }
      }
    };

    charts['actuals'] = new Chart(ctx, {
      type: 'line',
      plugins: [overlayPlugin],
      data: {
        labels: allLabels,
        datasets: [
          {
            label: 'Actual total pot',
            data: actualsDataArr,
            borderColor: '#16a34a',
            backgroundColor: 'rgba(22,163,74,0.08)',
            fill: false, tension: 0.1, pointRadius: 2, pointHoverRadius: 6,
            borderWidth: 2, spanGaps: false,
          },
          {
            label: `Forecast (${returnPct}% return, from latest actuals)`,
            data: forecastDataArr,
            borderColor: 'rgba(37,99,235,0.7)',
            backgroundColor: 'rgba(37,99,235,0.06)',
            fill: true, tension: 0.3, pointRadius: 4, pointHoverRadius: 6,
            borderWidth: 1.5, borderDash: [5, 3], spanGaps: false,
          },
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: textColor(), font: { size: 11 } } },
          tooltip: {
            callbacks: {
              title: items => items[0]?.label || '',
              afterBody: items => {
                const idx = items[0]?.dataIndex;
                if (idx == null || idx >= snapshotData.length) return [];
                const pots = snapshotData[idx].perPot;
                return [
                  '─────────────────',
                  ...pots.map(p => `${p.name}: ${fmtGBP(p.value)}${p.isActual ? '' : ' (est.)'}`),
                ];
              },
            }
          }
        },
        scales: {
          x: {
            ticks: {
              color: textColor(),
              maxRotation: 45,
              autoSkip: true,
              maxTicksLimit: 16,
              callback(val, idx) {
                const lbl = allLabels[idx] || '';
                return lbl.endsWith('-01-01') ? lbl.slice(0, 4) : lbl.slice(0, 7);
              }
            },
            grid: { color: gridColor() },
            title: { display: true, text: 'Date', color: textColor() }
          },
          y: {
            ticks: { color: textColor(), callback: v => fmtAxisGBP(v) },
            grid: { color: gridColor() },
            title: { display: true, text: useToday ? "Pot Value (£, today's money)" : 'Pot Value (£, nominal)', color: textColor() }
          }
        }
      }
    });
  }

  // ── Income actuals table ──────────────────────────────────────────────
  const incomeRows = actualsEvents
    .filter(e => e.type === 'income_actual' && e.date)
    .sort((a, b) => b.date.localeCompare(a.date));
  const incomeTbody = document.getElementById('actuals-income-tbody');
  if (incomeTbody) {
    incomeTbody.innerHTML = incomeRows.length
      ? incomeRows.map(e => `<tr>
          <td>${e.date}</td>
          <td>${e.targetName || '—'}</td>
          <td style="text-align:right">${fmtGBP(e.amount)}</td>
          <td style="color:var(--text2)">${e.notes || ''}</td>
        </tr>`).join('')
      : '<tr><td colspan="4" style="text-align:center;color:var(--text2);padding:12px">No income actuals logged</td></tr>';
  }
}

// ── Tab switching ──────────────────────────────────────────────────────────
const tabDefs = ['pot', 'annualincome', 'taxbreakdown', 'realincome', 'netmonthly', 'montecarlo', 'historicalreplay', 'actuals'];
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
    persistParams();
    if (lastResults) {
      if (tab === 'pot') renderPotChart(lastResults);
      else if (tab === 'taxbreakdown') renderTaxBreakdown(lastResults);
      else if (tab === 'realincome') renderRealIncomeChart(lastResults);
      else if (tab === 'netmonthly') { renderNetMonthlyChart(lastResults); renderIncomeTable(lastResults); }
      else if (tab === 'annualincome') { renderAnnualIncomeChart(lastResults); renderAnnualIncomeTable(lastResults); }
      else if (tab === 'montecarlo') { renderMonteCarloChart(lastResults); renderMonteCarloTable(lastResults, +document.getElementById('mc-pctile').value); renderSurvivalChart(lastResults); }
      else if (tab === 'historicalreplay') renderHistoricalReplayTab(lastResults);
      else if (tab === 'actuals') renderActualsTab(lastResults);
    }
    // Sync active checkbox state to persisted value when tabs change
    setTodayMoney(todayPrices, lastResults);
  });
});

// ── Run button ─────────────────────────────────────────────────────────────
document.getElementById('run-btn').addEventListener('click', () => {
  sanitizeParams();
  const btn = document.getElementById('run-btn');
  btn.disabled = true;
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
      renderAccumulationCards(r);
      renderIncomeTable(r);

      if (activeTab === 'pot') renderPotChart(r);
      else if (activeTab === 'taxbreakdown') renderTaxBreakdown(r);
      else if (activeTab === 'realincome') renderRealIncomeChart(r);
      else if (activeTab === 'netmonthly') renderNetMonthlyChart(r);
      else if (activeTab === 'annualincome') { renderAnnualIncomeChart(r); renderAnnualIncomeTable(r); }
      else if (activeTab === 'montecarlo') { renderMonteCarloChart(r); renderMonteCarloTable(r, +document.getElementById('mc-pctile').value); renderSurvivalChart(r); }
      else if (activeTab === 'historicalreplay') renderHistoricalReplayTab(r);
      else if (activeTab === 'actuals') renderActualsTab(r);

      setActiveTab(activeTab);
    } catch (err) {
      console.error('Run simulation failed', err);
    } finally {
      btn.disabled = false;
      if (_restoreScrollOnNextRun) {
        _restoreScrollOnNextRun = false;
        requestAnimationFrame(() => restoreScrollState());
      }
    }
  }, 10);
});
let _restoreScrollOnNextRun = false;

// ── Init ───────────────────────────────────────────────────────────────────
const SCROLL_KEY = 'rc-scroll';
function saveScrollState() {
  try {
    const sidebar = document.getElementById('sidebar');
    sessionStorage.setItem(SCROLL_KEY, JSON.stringify({
      pageY: window.scrollY,
      sidebarY: sidebar ? sidebar.scrollTop : 0
    }));
  } catch(e) {}
}
function restoreScrollState() {
  try {
    const raw = sessionStorage.getItem(SCROLL_KEY);
    if (!raw) return;
    const { pageY, sidebarY } = JSON.parse(raw);
    if (pageY) window.scrollTo({ top: pageY, behavior: 'instant' });
    const sidebar = document.getElementById('sidebar');
    if (sidebar && sidebarY) requestAnimationFrame(() => requestAnimationFrame(() => { sidebar.scrollTop = sidebarY; }));
  } catch(e) {}
}

function initApp() {
  const toggleBtn = document.getElementById('sidebar-toggle');
  const sidebar = document.getElementById('sidebar');
  toggleBtn.addEventListener('click', () => {
    const isOpen = sidebar.classList.toggle('open');
    toggleBtn.textContent = isOpen ? '✕' : '⚙';
    toggleBtn.setAttribute('aria-expanded', isOpen);
    if (isOpen) {
      // Restore sidebar scroll when panel opens — defer until after layout
      try {
        const raw = sessionStorage.getItem(SCROLL_KEY);
        if (raw) {
          const { sidebarY } = JSON.parse(raw);
          if (sidebarY) requestAnimationFrame(() => requestAnimationFrame(() => { sidebar.scrollTop = sidebarY; }));
        }
      } catch(e) {}
    } else {
      saveScrollState();
    }
  });
  document.getElementById('run-btn').addEventListener('click', () => {
    if (window.innerWidth <= 768) {
      saveScrollState();
      sidebar.classList.remove('open');
      toggleBtn.textContent = '⚙';
      toggleBtn.setAttribute('aria-expanded', false);
    }
  }, true);

  document.querySelectorAll('input[name="drawdown-mode"]').forEach(radio => {
    radio.addEventListener('change', () => { updateDrawdownMode(radio.value); persistParams(); });
  });
  document.getElementById('guardrails').addEventListener('change', persistParams);
  document.getElementById('always-taxfree').addEventListener('change', persistParams);
  document.getElementById('drawdown-inflation').addEventListener('change', persistParams);

  // Sequence of Returns Risk stress test
  document.getElementById('sorr-enabled')?.addEventListener('change', () => {
    const enabled = document.getElementById('sorr-enabled').checked;
    const controls = document.getElementById('sorr-controls');
    if (controls) controls.classList.toggle('hidden', !enabled);
    persistParams();
    if (lastResults) renderPotChart(lastResults);
  });
  document.getElementById('sorr-crash-pct')?.addEventListener('input', () => {
    const val = +document.getElementById('sorr-crash-pct').value;
    const lbl = document.getElementById('v-sorr-crash-pct');
    if (lbl) lbl.textContent = val + '%';
    persistParams();
    if (lastResults) renderPotChart(lastResults);
  });
  document.getElementById('sorr-crash-years')?.addEventListener('input', () => {
    const val = +document.getElementById('sorr-crash-years').value;
    const lbl = document.getElementById('v-sorr-crash-years');
    if (lbl) lbl.textContent = val + (val === 1 ? ' year' : ' years');
    persistParams();
    if (lastResults) renderPotChart(lastResults);
  });
  document.getElementById('sorr-table-toggle')?.addEventListener('click', () => {
    const wrap = document.getElementById('sorr-table-wrap');
    const btn = document.getElementById('sorr-table-toggle');
    if (!wrap) return;
    const hidden = wrap.classList.toggle('hidden');
    if (btn) btn.textContent = hidden ? 'Show year-by-year' : 'Hide year-by-year';
    persistParams();
  });
  document.getElementById('income-reduction-enabled')?.addEventListener('change', () => {
    const enabled = document.getElementById('income-reduction-enabled').checked;
    const slidersDiv = document.getElementById('income-reduction-sliders');
    if (slidersDiv) slidersDiv.style.display = enabled ? '' : 'none';
    persistParams();
    document.getElementById('run-btn').click();
  });

  // Annuity toggle
  document.getElementById('annuity-enabled')?.addEventListener('change', () => {
    const enabled = document.getElementById('annuity-enabled').checked;
    const fields = document.getElementById('annuity-fields');
    if (fields) fields.classList.toggle('hidden', !enabled);
    persistParams();
    document.getElementById('run-btn').click();
  });
  document.getElementById('annuity-age')?.addEventListener('input', () => {
    const val = document.getElementById('annuity-age').value;
    const lbl = document.getElementById('v-annuity-age');
    if (lbl) lbl.textContent = val;
    persistParams();
  });
  document.getElementById('annuity-premium')?.addEventListener('input', persistParams);
  document.getElementById('annuity-income')?.addEventListener('input', persistParams);

  // Spending goals
  document.getElementById('add-goal-btn')?.addEventListener('click', () => {
    addSpendingGoal();
    renderSpendingGoalsUI();
    persistParams();
  });

  // Save as Baseline button
  document.getElementById('save-baseline-btn')?.addEventListener('click', () => {
    if (lastResults) saveBaseline(lastResults);
  });

  // Tax-free cash mode (primary + partner)
  document.getElementById('pcls-enabled')?.addEventListener('change', () => { updateTfMode('primary'); persistParams(); document.getElementById('run-btn').click(); });
  document.getElementById('pcls-pct')?.addEventListener('input', () => {
    const el = document.getElementById('pcls-pct');
    const lbl = document.getElementById('v-pcls-pct');
    if (lbl) lbl.textContent = el.value + '%';
    persistParams(); document.getElementById('run-btn').click();
  });
  document.getElementById('partner-pcls-enabled')?.addEventListener('change', () => { updateTfMode('partner'); persistParams(); document.getElementById('run-btn').click(); });
  document.getElementById('partner-pcls-pct')?.addEventListener('input', () => {
    const el = document.getElementById('partner-pcls-pct');
    const lbl = document.getElementById('v-partner-pcls-pct');
    if (lbl) lbl.textContent = el.value + '%';
    persistParams(); document.getElementById('run-btn').click();
  });

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

  initPotModal();
  loadActuals();
  initImportDialog();
  initJournalForm();
  renderJournalRecent();
  document.getElementById('export-backup-btn')?.addEventListener('click', exportBackup);
  updateBackupBadge();
  document.getElementById('actuals-enabled')?.addEventListener('change', (e) => {
    applyActualsEnabled(e.target.checked);
    persistParams();
    // On mobile with sidebar open, skip re-render — user can't see results anyway
    const sidebarOpen = window.innerWidth <= 768 && document.getElementById('sidebar')?.classList.contains('open');
    if (lastResults && !sidebarOpen) {
      const r = runSimulation();
      if (r) {
        r.annualIncomeData = buildAnnualIncomeData(r);
        renderCards(r);
        const explain = buildExplainability(getParams(), r);
        renderExplainability(explain, r);
        renderAccumulationCards(r);
        renderIncomeTable(r);
        const activeTab = document.querySelector('.tab.active')?.dataset.tab || 'pot';
        if (activeTab === 'pot') renderPotChart(r);
        else if (activeTab === 'taxbreakdown') renderTaxBreakdown(r);
        else if (activeTab === 'realincome') renderRealIncomeChart(r);
        else if (activeTab === 'netmonthly') renderNetMonthlyChart(r);
        else if (activeTab === 'annualincome') { renderAnnualIncomeChart(r); renderAnnualIncomeTable(r); }
        else if (activeTab === 'montecarlo') { renderMonteCarloChart(r); renderMonteCarloTable(r, +document.getElementById('mc-pctile').value); renderSurvivalChart(r); }
        else if (activeTab === 'historicalreplay') renderHistoricalReplayTab(r);
        else if (activeTab === 'actuals') renderActualsTab(r);
      }
    }
  });

  document.getElementById('recalibrate-toggle')?.addEventListener('change', () => {
    document.getElementById('run-btn').click();
  });

  const addIncomeBtn = document.getElementById('add-income-btn');
  if (addIncomeBtn) addIncomeBtn.addEventListener('click', () => { addIncome('Income source', 0, 'annual', 20); persistParams(); });

  const addDbPensionBtn = document.getElementById('add-db-pension-btn');
  if (addDbPensionBtn) addDbPensionBtn.addEventListener('click', () => { addDbPension(); persistParams(); });

  const addPartnerDbPensionBtn = document.getElementById('add-partner-db-pension-btn');
  if (addPartnerDbPensionBtn) addPartnerDbPensionBtn.addEventListener('click', () => { addPartnerDbPension(); persistParams(); });

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

  // DOB pickers initialised after restoreParams() — see end of initApp

  const mcPctileSlider = document.getElementById('mc-pctile');
  const mcPctileLabel  = document.getElementById('v-mc-pctile');
  mcPctileSlider.addEventListener('input', () => {
    const idx = +mcPctileSlider.value;
    mcPctileLabel.textContent = MC_PCT_LABELS[idx];
    if (lastResults) renderMonteCarloTable(lastResults, idx);
    persistParams();
  });

  const taxYearSelect = document.getElementById('tax-year-select');
  if (taxYearSelect) {
    taxYearSelect.addEventListener('change', () => {
      localStorage.setItem('taxYearIdx', taxYearSelect.value);
      if (lastResults) renderTaxBreakdown(lastResults);
    });
  }

  populateHistReplayDropdown();
  const histReplayYearSel = document.getElementById('hist-replay-year');
  if (histReplayYearSel) {
    histReplayYearSel.addEventListener('change', () => {
      if (lastResults) renderHistoricalReplayTab(lastResults);
      persistParams();
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

  // Apply actuals enabled state (covers fresh loads and old saved state without the key)
  applyActualsEnabled(isActualsEnabled());

  // ── Flatpickr DOB pickers ─────────────────────────────────────────────
  // Initialised here so defaultDate picks up the already-restored value.
  function _initDobPicker(inputId, labelId) {
    const el = document.getElementById(inputId);
    const lbl = document.getElementById(labelId);
    if (!el || !window.flatpickr) return;
    flatpickr(el, {
      dateFormat: 'Y-m-d',
      maxDate: 'today',
      minDate: '1930-01-01',
      defaultDate: el.value || null,
      disableMobile: true,
      onChange(selectedDates, dateStr) {
        if (!dateStr) return;
        const age = dobToAge(dateStr);
        if (age > 0 && age < 120) {
          if (lbl) lbl.textContent = 'Age ' + age;
          persistParams();
          document.getElementById('run-btn').click();
        }
      }
    });
  }
  _initDobPicker('current-dob', 'v-current-age');
  _initDobPicker('partner-dob', 'v-partner-age');

  _restoreScrollOnNextRun = true;
  document.getElementById('run-btn').click();
  updateMobileHeaderOffset();
}

// Persist window scroll position (debounced)
let _scrollSaveTimer = null;
window.addEventListener('scroll', () => {
  clearTimeout(_scrollSaveTimer);
  _scrollSaveTimer = setTimeout(saveScrollState, 300);
}, { passive: true });

function updateMobileHeaderOffset() {
  const stg = document.querySelector('.sticky-top-group');
  const layout = document.querySelector('.layout');
  if (!stg || !layout) return;
  layout.style.marginTop = window.innerWidth <= 768 ? stg.offsetHeight + 'px' : '';
}
window.addEventListener('resize', updateMobileHeaderOffset);

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
