'use client';

import { useEffect } from 'react';
import { useFinancialStore } from '@/lib/store/financialStore';
import { StrategyType } from '@/types/financial';

const STRATEGIES: { type: StrategyType; name: string }[] = [
  { type: 'RAMSEY', name: 'Ramsey' },
  { type: 'FIRE', name: 'FIRE' },
  { type: 'FOO', name: 'Money Guy' },
];

export default function Dashboard({ onEdit }: { onEdit: () => void }) {
  const {
    strategy,
    setStrategy,
    snapshot,
    nextStep,
    currentAge,
    targetRetirementAge,
    recalculate,
    resetAll,
  } = useFinancialStore();

  // Ensure steps are calculated when dashboard mounts
  useEffect(() => {
    // Small delay to ensure store is ready
    const timer = setTimeout(() => {
      recalculate();
    }, 50);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const formatCurrency = (n: number) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    }).format(n);

  // Calculations
  const totalDebt = snapshot.debts.reduce((s, d) => s + d.balance, 0);
  const netWorth = snapshot.emergencyFund + snapshot.retirementBalance - totalDebt;
  const yearsToRetirement = targetRetirementAge - currentAge;
  const retirementProgress = Math.min(100, Math.round((currentAge / targetRetirementAge) * 100));

  // Simple FI projection (very rough)
  const annualSavings = (snapshot.contributionPercent / 100) * snapshot.grossAnnualIncome;
  const yearsToFI = annualSavings > 0
    ? Math.round((snapshot.monthlyExpenses * 12 * 25 - snapshot.retirementBalance) / annualSavings)
    : 99;
  const fiYear = new Date().getFullYear() + Math.max(0, yearsToFI);

  return (
    <div className="min-h-screen p-6 md:p-12">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-10">
          <h1>Financial GPS</h1>
          <button onClick={onEdit} className="btn btn-ghost">
            Edit
          </button>
        </div>

        {/* Strategy Toggle */}
        <div className="flex gap-2 mb-10 p-1 bg-[var(--background-card)] rounded-2xl w-fit">
          {STRATEGIES.map((s) => (
            <button
              key={s.type}
              onClick={() => setStrategy(s.type)}
              className={`px-5 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                strategy === s.type
                  ? 'bg-[var(--gold)] text-black'
                  : 'text-secondary hover:text-foreground'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>

        {/* Hero: Next Step */}
        {nextStep && (
          <div className="card mb-8 relative overflow-hidden">
            <div
              className="absolute top-0 left-0 h-1 bg-[var(--gold)]"
              style={{ width: `${nextStep.progress || 0}%` }}
            />
            <span className="badge badge-gold mb-4">Next Step</span>
            <h2 className="mb-2">{nextStep.title}</h2>
            <p className="text-secondary mb-6">{nextStep.description}</p>

            {nextStep.progress !== undefined && (
              <div className="progress-lg">
                <div className="flex justify-between text-sm mb-2">
                  <span className="text-secondary">Progress</span>
                  <span className="text-gold font-semibold">{nextStep.progress}%</span>
                </div>
                <div className="progress-track">
                  <div
                    className="progress-fill"
                    style={{ width: `${nextStep.progress}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Retirement Runway */}
        <div className="card mb-8">
          <div className="flex items-end justify-between mb-6">
            <div>
              <p className="text-secondary text-sm uppercase tracking-wide mb-1">Retirement Runway</p>
              <h2 className="text-gold">{yearsToRetirement} years</h2>
            </div>
            <div className="text-right">
              <p className="text-dim text-sm">Target Age</p>
              <p className="text-2xl font-semibold">{targetRetirementAge}</p>
            </div>
          </div>

          {/* Timeline Visual */}
          <div className="relative">
            <div className="progress-track h-3 rounded-full">
              <div
                className="progress-fill h-3"
                style={{ width: `${retirementProgress}%` }}
              />
            </div>
            <div className="flex justify-between mt-2 text-sm">
              <span className="text-secondary">{currentAge} now</span>
              <span className="text-secondary">{targetRetirementAge}</span>
            </div>
          </div>

          {/* FI Projection */}
          <div className="mt-6 pt-6 border-t border-[var(--border)]">
            <p className="text-secondary text-sm">
              At your current {snapshot.contributionPercent}% savings rate, you could reach financial independence by{' '}
              <span className="text-gold font-semibold">{fiYear}</span>
              {yearsToFI <= yearsToRetirement && yearsToFI > 0 && (
                <span className="text-success"> — {yearsToRetirement - yearsToFI} years early!</span>
              )}
            </p>
          </div>
        </div>

        {/* Quick Stats */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <div className="card text-center py-6">
            <p className="text-dim text-xs uppercase tracking-wide mb-1">Net Worth</p>
            <p className={`text-xl font-semibold ${netWorth >= 0 ? 'text-success' : 'text-danger'}`}>
              {formatCurrency(netWorth)}
            </p>
          </div>
          <div className="card text-center py-6">
            <p className="text-dim text-xs uppercase tracking-wide mb-1">Saved</p>
            <p className="text-xl font-semibold">{formatCurrency(snapshot.emergencyFund)}</p>
          </div>
          <div className="card text-center py-6">
            <p className="text-dim text-xs uppercase tracking-wide mb-1">Debt</p>
            <p className={`text-xl font-semibold ${totalDebt > 0 ? 'text-danger' : 'text-success'}`}>
              {formatCurrency(totalDebt)}
            </p>
          </div>
        </div>

        {/* Debt List (if any) */}
        {snapshot.debts.length > 0 && (
          <div className="card">
            <h3 className="mb-4 text-secondary">Debt Payoff Order</h3>
            <div className="space-y-3">
              {snapshot.debts
                .slice()
                .sort((a, b) =>
                  strategy === 'RAMSEY'
                    ? a.balance - b.balance
                    : b.interestRate - a.interestRate
                )
                .map((debt, i) => (
                  <div
                    key={debt.id}
                    className={`flex items-center justify-between p-4 rounded-xl ${
                      i === 0 ? 'bg-[var(--gold-soft)]' : 'bg-[var(--background-input)]'
                    }`}
                  >
                    <div className="flex items-center gap-4">
                      <span
                        className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold ${
                          i === 0 ? 'bg-[var(--gold)] text-black' : 'bg-[var(--border)] text-secondary'
                        }`}
                      >
                        {i + 1}
                      </span>
                      <div>
                        <p className="font-medium">{debt.name}</p>
                        <p className="text-sm text-secondary">{debt.interestRate}% APR</p>
                      </div>
                    </div>
                    <p className={`font-semibold ${i === 0 ? 'text-gold' : ''}`}>
                      {formatCurrency(debt.balance)}
                    </p>
                  </div>
                ))}
            </div>
            <p className="text-dim text-sm mt-4">
              {strategy === 'RAMSEY' ? 'Snowball: Smallest balance first' : 'Avalanche: Highest rate first'}
            </p>
          </div>
        )}

        {/* Debug Info - Remove in production */}
        <div className="card mb-8 text-xs font-mono">
          <h3 className="mb-2 text-secondary">Debug Data</h3>
          <div className="space-y-1 text-dim">
            <p>Income: ${snapshot.grossAnnualIncome}</p>
            <p>Monthly Expenses: ${snapshot.monthlyExpenses}</p>
            <p>Emergency Fund: ${snapshot.emergencyFund}</p>
            <p>Retirement Balance: ${snapshot.retirementBalance}</p>
            <p>Contribution %: {snapshot.contributionPercent}%</p>
            <p>Debts: {snapshot.debts.length}</p>
            <p>Strategy: {strategy}</p>
            <p>Next Step: {nextStep ? nextStep.title : 'null'}</p>
            <p>Age: {currentAge} → {targetRetirementAge}</p>
          </div>
          <button
            onClick={() => { resetAll(); onEdit(); }}
            className="mt-4 text-danger underline"
          >
            Reset All Data
          </button>
        </div>

        {/* Footer */}
        <p className="text-center text-dim text-sm mt-10">
          Data stored locally in your browser
        </p>
      </div>
    </div>
  );
}
