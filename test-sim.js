import { runSimulation as runSimulationImpl } from './src/simulation.js';

const p = {
  currentAge: 50,
  retirementAge: 65,
  endAge: 95,
  spAge: 67,
  reductionAge: 75,
  reductionPct: 25,
  drawdown: 50000,
  sp: 12540,
  inflation: 2,
  runs: 1000,
  guardrails: true,
  drawdownMode: 'amount',
  drawdownPct: 4.5,
  drawdownInflation: true,
  pots: [{id: 1, value: 500000, annualContrib: 10000, equityPct: 80}],
  incomes: [],
  cashPots: [],
  partner: null
};

try {
  const r = runSimulationImpl(p);
  console.log('✅ Simulation ran:', !!r, '| prob:', r?.prob, '| medianReal:', r?.medianReal);
} catch(e) {
  console.error('❌ Simulation error:', e.message);
}
