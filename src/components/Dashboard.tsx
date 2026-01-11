'use client';

import { useFinancialStore } from '@/lib/store/financialStore';
import { StrategyType, FinancialStep } from '@/types/financial';

const STRATEGY_LABELS: Record<StrategyType, { name: string; tagline: string }> = {
  RAMSEY: { name: 'Dave Ramsey', tagline: 'Peace & Debt-Free Focus' },
  FIRE: { name: 'FIRE', tagline: 'Math & Net Worth Focus' },
  FOO: { name: 'Money Guy (FOO)', tagline: 'Hybrid & Behavior Focus' },
};

export default function Dashboard({ onEditData }: { onEditData: () => void }) {
  const { strategy, setStrategy, snapshot, currentSteps, nextStep, birthYear } = useFinancialStore();

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  // Calculate totals
  const totalSavings = snapshot.emergencyFund + snapshot.checkingBalance + snapshot.liquidCash;
  const totalRetirement = snapshot.retirement401k + snapshot.rothIra + snapshot.hsa;
  const totalInvested = totalRetirement + snapshot.taxableBrokerage;
  const totalDebt = snapshot.debts.reduce((sum, d) => sum + d.balance, 0);
  const netWorth = totalSavings + totalInvested - totalDebt;

  // Calculate age
  const currentYear = new Date().getFullYear();
  const age = currentYear - birthYear;

  // Group steps by status
  const completedSteps = currentSteps.filter(s => s.status === 'COMPLETED');
  const inProgressSteps = currentSteps.filter(s => s.status === 'IN_PROGRESS');
  const upcomingSteps = currentSteps.filter(s => s.status === 'NOT_STARTED');

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-3xl md:text-4xl mb-1">Financial GPS</h1>
            <p className="text-[var(--text-muted)]">Your personal money roadmap</p>
          </div>
          <button onClick={onEditData} className="btn btn-secondary">
            Edit My Data
          </button>
        </div>

        {/* Strategy Selector */}
        <div className="card">
          <div className="flex flex-col md:flex-row md:items-center gap-4">
            <label className="text-[var(--text-muted)] mb-0 whitespace-nowrap">Strategy:</label>
            <div className="flex flex-wrap gap-2">
              {(['RAMSEY', 'FIRE', 'FOO'] as StrategyType[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setStrategy(s)}
                  className={`px-4 py-2 rounded-lg font-medium transition-all ${
                    strategy === s
                      ? 'bg-[var(--gold)] text-[var(--navy)]'
                      : 'bg-[var(--background-secondary)] text-[var(--text-muted)] hover:text-[var(--foreground)]'
                  }`}
                >
                  {STRATEGY_LABELS[s].name}
                </button>
              ))}
            </div>
            <p className="text-sm text-[var(--text-dim)] md:ml-4">
              {STRATEGY_LABELS[strategy].tagline}
            </p>
          </div>
        </div>

        {/* Hero Mission Card */}
        {nextStep && (
          <div
            className={`card border-2 ${
              nextStep.isDebtStep ? 'border-[var(--danger)]' : 'border-[var(--success)]'
            }`}
          >
            <div className="flex items-start gap-4">
              <div
                className={`w-12 h-12 rounded-full flex items-center justify-center text-2xl ${
                  nextStep.isDebtStep ? 'bg-[var(--danger-bg)]' : 'bg-[var(--success-bg)]'
                }`}
              >
                {nextStep.isDebtStep ? '🎯' : '📈'}
              </div>
              <div className="flex-1">
                <p className="text-sm text-[var(--text-muted)] mb-1">YOUR NEXT STEP</p>
                <h2 className="text-2xl mb-2">{nextStep.title}</h2>
                <p className="text-[var(--text-muted)]">{nextStep.description}</p>

                {nextStep.progress !== undefined && (
                  <div className="mt-4">
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-[var(--text-muted)]">Progress</span>
                      <span className="font-medium">{nextStep.progress}%</span>
                    </div>
                    <div className="progress-bar">
                      <div
                        className="progress-bar-fill"
                        style={{ width: `${nextStep.progress}%` }}
                      />
                    </div>
                    {nextStep.currentAmount !== undefined && nextStep.targetAmount !== undefined && (
                      <p className="text-sm text-[var(--text-dim)] mt-1">
                        {formatCurrency(nextStep.currentAmount)} of {formatCurrency(nextStep.targetAmount)}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            label="Net Worth"
            value={formatCurrency(netWorth)}
            trend={netWorth >= 0 ? 'positive' : 'negative'}
          />
          <StatCard
            label="Total Savings"
            value={formatCurrency(totalSavings)}
          />
          <StatCard
            label="Total Debt"
            value={formatCurrency(totalDebt)}
            trend={totalDebt > 0 ? 'negative' : 'positive'}
          />
          <StatCard
            label="Retirement"
            value={formatCurrency(totalRetirement)}
          />
        </div>

        {/* Steps Progress */}
        <div className="grid md:grid-cols-3 gap-4">
          {/* Completed */}
          <div className="card">
            <div className="flex items-center gap-2 mb-4">
              <span className="badge badge-success">Completed</span>
              <span className="text-[var(--text-dim)]">{completedSteps.length} steps</span>
            </div>
            <div className="space-y-3">
              {completedSteps.slice(0, 5).map((step) => (
                <StepItem key={step.action} step={step} />
              ))}
              {completedSteps.length > 5 && (
                <p className="text-sm text-[var(--text-dim)]">
                  + {completedSteps.length - 5} more completed
                </p>
              )}
              {completedSteps.length === 0 && (
                <p className="text-[var(--text-dim)] text-sm">No steps completed yet</p>
              )}
            </div>
          </div>

          {/* In Progress */}
          <div className="card">
            <div className="flex items-center gap-2 mb-4">
              <span className="badge badge-warning">In Progress</span>
              <span className="text-[var(--text-dim)]">{inProgressSteps.length} steps</span>
            </div>
            <div className="space-y-3">
              {inProgressSteps.map((step) => (
                <StepItem key={step.action} step={step} showProgress />
              ))}
              {inProgressSteps.length === 0 && (
                <p className="text-[var(--text-dim)] text-sm">No steps in progress</p>
              )}
            </div>
          </div>

          {/* Upcoming */}
          <div className="card">
            <div className="flex items-center gap-2 mb-4">
              <span className="badge" style={{ background: 'var(--background-secondary)', color: 'var(--text-muted)' }}>
                Upcoming
              </span>
              <span className="text-[var(--text-dim)]">{upcomingSteps.length} steps</span>
            </div>
            <div className="space-y-3">
              {upcomingSteps.slice(0, 5).map((step) => (
                <StepItem key={step.action} step={step} />
              ))}
              {upcomingSteps.length > 5 && (
                <p className="text-sm text-[var(--text-dim)]">
                  + {upcomingSteps.length - 5} more upcoming
                </p>
              )}
              {upcomingSteps.length === 0 && (
                <p className="text-[var(--text-dim)] text-sm">All steps in progress or complete!</p>
              )}
            </div>
          </div>
        </div>

        {/* Debt List (if any) */}
        {snapshot.debts.length > 0 && (
          <div className="card">
            <h3 className="text-xl mb-4">Your Debts (by {strategy === 'RAMSEY' ? 'Snowball' : 'Avalanche'})</h3>
            <div className="space-y-3">
              {snapshot.debts
                .slice()
                .sort((a, b) =>
                  strategy === 'RAMSEY'
                    ? a.balance - b.balance  // Snowball: smallest first
                    : b.interestRate - a.interestRate  // Avalanche: highest rate first
                )
                .map((debt, index) => (
                  <div
                    key={debt.id}
                    className={`flex items-center justify-between p-3 rounded-lg ${
                      index === 0 ? 'bg-[var(--danger-bg)] border border-[var(--danger)]' : 'bg-[var(--background-secondary)]'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span className="w-6 h-6 rounded-full bg-[var(--background)] flex items-center justify-center text-sm font-medium">
                        {index + 1}
                      </span>
                      <div>
                        <p className="font-medium">{debt.name}</p>
                        <p className="text-sm text-[var(--text-muted)]">
                          {debt.interestRate}% APR • {formatCurrency(debt.minimumPayment)}/mo min
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold text-[var(--danger)]">{formatCurrency(debt.balance)}</p>
                      {index === 0 && (
                        <span className="text-xs text-[var(--danger)]">← Attack this first</span>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="text-center text-[var(--text-dim)] text-sm py-4">
          <p>Age: {age} • Strategy: {STRATEGY_LABELS[strategy].name}</p>
          <p className="mt-1">Data stored locally in your browser</p>
        </div>
      </div>
    </div>
  );
}

// Stat Card Component
function StatCard({
  label,
  value,
  trend,
}: {
  label: string;
  value: string;
  trend?: 'positive' | 'negative';
}) {
  return (
    <div className="card">
      <p className="text-sm text-[var(--text-muted)] mb-1">{label}</p>
      <p
        className={`text-xl md:text-2xl font-semibold ${
          trend === 'positive'
            ? 'text-[var(--success)]'
            : trend === 'negative'
            ? 'text-[var(--danger)]'
            : ''
        }`}
      >
        {value}
      </p>
    </div>
  );
}

// Step Item Component
function StepItem({ step, showProgress }: { step: FinancialStep; showProgress?: boolean }) {
  return (
    <div className="flex items-start gap-3">
      <div
        className={`w-2 h-2 rounded-full mt-2 ${
          step.status === 'COMPLETED'
            ? 'bg-[var(--success)]'
            : step.status === 'IN_PROGRESS'
            ? 'bg-[var(--warning)]'
            : 'bg-[var(--text-dim)]'
        }`}
      />
      <div className="flex-1 min-w-0">
        <p className={`text-sm truncate ${step.isDebtStep ? 'text-[var(--danger)]' : ''}`}>
          {step.title}
        </p>
        {showProgress && step.progress !== undefined && (
          <div className="mt-1">
            <div className="progress-bar h-1">
              <div className="progress-bar-fill" style={{ width: `${step.progress}%` }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
