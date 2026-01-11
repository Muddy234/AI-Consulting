'use client';

import { useState } from 'react';
import { useFinancialStore } from '@/lib/store/financialStore';
import { Debt, DebtCategory, StrategyType } from '@/types/financial';

type WizardStep = 'income' | 'expenses' | 'assets' | 'debts' | 'retirement' | 'summary';

const WIZARD_STEPS: { key: WizardStep; label: string }[] = [
  { key: 'income', label: 'Income' },
  { key: 'expenses', label: 'Expenses' },
  { key: 'assets', label: 'Assets' },
  { key: 'debts', label: 'Debts' },
  { key: 'retirement', label: 'Retirement' },
  { key: 'summary', label: 'Summary' },
];

const DEBT_CATEGORIES: { value: DebtCategory; label: string }[] = [
  { value: 'CREDIT_CARD', label: 'Credit Card' },
  { value: 'AUTO', label: 'Auto Loan' },
  { value: 'STUDENT', label: 'Student Loan' },
  { value: 'PERSONAL', label: 'Personal Loan' },
  { value: 'MORTGAGE', label: 'Mortgage' },
  { value: 'OTHER', label: 'Other' },
];

const STRATEGY_OPTIONS: { value: StrategyType; label: string; description: string }[] = [
  { value: 'RAMSEY', label: 'Dave Ramsey', description: 'Debt-free focus, psychological wins' },
  { value: 'FIRE', label: 'FIRE', description: 'Math optimization, net worth focus' },
  { value: 'FOO', label: 'Money Guy (FOO)', description: 'Balanced 25% savings approach' },
];

export default function InputWizard({ onComplete }: { onComplete: () => void }) {
  const [currentStep, setCurrentStep] = useState<WizardStep>('income');
  const { snapshot, updateSnapshot, addDebt, removeDebt, strategy, setStrategy, birthYear, setBirthYear } = useFinancialStore();

  // Local state for new debt form
  const [newDebt, setNewDebt] = useState<Partial<Debt>>({
    name: '',
    balance: 0,
    interestRate: 0,
    minimumPayment: 0,
    category: 'CREDIT_CARD',
  });

  const stepIndex = WIZARD_STEPS.findIndex(s => s.key === currentStep);

  const nextStep = () => {
    if (stepIndex < WIZARD_STEPS.length - 1) {
      setCurrentStep(WIZARD_STEPS[stepIndex + 1].key);
    }
  };

  const prevStep = () => {
    if (stepIndex > 0) {
      setCurrentStep(WIZARD_STEPS[stepIndex - 1].key);
    }
  };

  const handleAddDebt = () => {
    if (newDebt.name && newDebt.balance && newDebt.balance > 0) {
      addDebt({
        id: crypto.randomUUID(),
        name: newDebt.name,
        balance: newDebt.balance,
        interestRate: newDebt.interestRate || 0,
        minimumPayment: newDebt.minimumPayment || 0,
        category: newDebt.category as DebtCategory,
      });
      setNewDebt({
        name: '',
        balance: 0,
        interestRate: 0,
        minimumPayment: 0,
        category: 'CREDIT_CARD',
      });
    }
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        {/* Progress Bar */}
        <div className="mb-8">
          <div className="flex justify-between mb-2">
            {WIZARD_STEPS.map((step, index) => (
              <button
                key={step.key}
                onClick={() => setCurrentStep(step.key)}
                className={`text-sm font-medium transition-colors ${
                  index <= stepIndex ? 'text-[var(--gold)]' : 'text-[var(--text-dim)]'
                }`}
              >
                {step.label}
              </button>
            ))}
          </div>
          <div className="progress-bar">
            <div
              className="progress-bar-fill"
              style={{ width: `${((stepIndex + 1) / WIZARD_STEPS.length) * 100}%` }}
            />
          </div>
        </div>

        {/* Card Container */}
        <div className="card">
          {/* Income Step */}
          {currentStep === 'income' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-2xl mb-2">Let&apos;s start with your income</h2>
                <p className="text-[var(--text-muted)]">Enter your annual gross income and monthly take-home pay.</p>
              </div>

              <div className="space-y-4">
                <div>
                  <label>Gross Annual Income</label>
                  <input
                    type="number"
                    placeholder="75000"
                    value={snapshot.grossAnnualIncome || ''}
                    onChange={(e) => updateSnapshot({ grossAnnualIncome: Number(e.target.value) })}
                  />
                </div>

                <div>
                  <label>Monthly Take-Home Pay (After Taxes)</label>
                  <input
                    type="number"
                    placeholder="4500"
                    value={snapshot.monthlyTakeHome || ''}
                    onChange={(e) => updateSnapshot({ monthlyTakeHome: Number(e.target.value) })}
                  />
                </div>

                <div>
                  <label>Birth Year</label>
                  <input
                    type="number"
                    placeholder="1990"
                    value={birthYear || ''}
                    onChange={(e) => setBirthYear(Number(e.target.value))}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Expenses Step */}
          {currentStep === 'expenses' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-2xl mb-2">Monthly Expenses</h2>
                <p className="text-[var(--text-muted)]">What do you typically spend each month?</p>
              </div>

              <div className="space-y-4">
                <div>
                  <label>Total Monthly Expenses</label>
                  <input
                    type="number"
                    placeholder="3500"
                    value={snapshot.monthlyExpenses || ''}
                    onChange={(e) => updateSnapshot({ monthlyExpenses: Number(e.target.value) })}
                  />
                  <p className="text-sm text-[var(--text-dim)] mt-1">
                    Include rent/mortgage, utilities, food, transportation, insurance, etc.
                  </p>
                </div>

                <div>
                  <label>Highest Insurance Deductible</label>
                  <input
                    type="number"
                    placeholder="2500"
                    value={snapshot.highestDeductible || ''}
                    onChange={(e) => updateSnapshot({ highestDeductible: Number(e.target.value) })}
                  />
                  <p className="text-sm text-[var(--text-dim)] mt-1">
                    Your highest deductible (health, auto, home). Used for emergency fund targets.
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    id="hasChildren"
                    checked={snapshot.hasChildren}
                    onChange={(e) => updateSnapshot({ hasChildren: e.target.checked })}
                    className="w-5 h-5"
                  />
                  <label htmlFor="hasChildren" className="mb-0">Do you have children?</label>
                </div>
              </div>
            </div>
          )}

          {/* Assets Step */}
          {currentStep === 'assets' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-2xl mb-2">Your Assets</h2>
                <p className="text-[var(--text-muted)]">What do you currently have saved?</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label>Checking Balance</label>
                  <input
                    type="number"
                    placeholder="2000"
                    value={snapshot.checkingBalance || ''}
                    onChange={(e) => updateSnapshot({ checkingBalance: Number(e.target.value) })}
                  />
                </div>

                <div>
                  <label>Emergency Fund / Savings</label>
                  <input
                    type="number"
                    placeholder="5000"
                    value={snapshot.emergencyFund || ''}
                    onChange={(e) => updateSnapshot({ emergencyFund: Number(e.target.value) })}
                  />
                </div>

                <div>
                  <label>Other Liquid Cash</label>
                  <input
                    type="number"
                    placeholder="0"
                    value={snapshot.liquidCash || ''}
                    onChange={(e) => updateSnapshot({ liquidCash: Number(e.target.value) })}
                  />
                </div>

                <div>
                  <label>Taxable Brokerage</label>
                  <input
                    type="number"
                    placeholder="0"
                    value={snapshot.taxableBrokerage || ''}
                    onChange={(e) => updateSnapshot({ taxableBrokerage: Number(e.target.value) })}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Debts Step */}
          {currentStep === 'debts' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-2xl mb-2">Your Debts</h2>
                <p className="text-[var(--text-muted)]">List all your debts (we&apos;ll help you tackle them).</p>
              </div>

              {/* Existing Debts */}
              {snapshot.debts.length > 0 && (
                <div className="space-y-2">
                  {snapshot.debts.map((debt) => (
                    <div
                      key={debt.id}
                      className="flex items-center justify-between p-3 bg-[var(--background-secondary)] rounded-lg"
                    >
                      <div>
                        <p className="font-medium">{debt.name}</p>
                        <p className="text-sm text-[var(--text-muted)]">
                          {formatCurrency(debt.balance)} @ {debt.interestRate}%
                        </p>
                      </div>
                      <button
                        onClick={() => removeDebt(debt.id)}
                        className="text-[var(--danger)] hover:text-red-400 p-2"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Add New Debt Form */}
              <div className="border border-[var(--border)] rounded-lg p-4 space-y-4">
                <h3 className="text-lg">Add a Debt</h3>

                <div className="grid grid-cols-2 gap-4">
                  <div className="col-span-2">
                    <label>Debt Name</label>
                    <input
                      type="text"
                      placeholder="Chase Credit Card"
                      value={newDebt.name}
                      onChange={(e) => setNewDebt({ ...newDebt, name: e.target.value })}
                    />
                  </div>

                  <div>
                    <label>Category</label>
                    <select
                      value={newDebt.category}
                      onChange={(e) => setNewDebt({ ...newDebt, category: e.target.value as DebtCategory })}
                    >
                      {DEBT_CATEGORIES.map((cat) => (
                        <option key={cat.value} value={cat.value}>{cat.label}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label>Balance</label>
                    <input
                      type="number"
                      placeholder="5000"
                      value={newDebt.balance || ''}
                      onChange={(e) => setNewDebt({ ...newDebt, balance: Number(e.target.value) })}
                    />
                  </div>

                  <div>
                    <label>Interest Rate (%)</label>
                    <input
                      type="number"
                      step="0.1"
                      placeholder="18.9"
                      value={newDebt.interestRate || ''}
                      onChange={(e) => setNewDebt({ ...newDebt, interestRate: Number(e.target.value) })}
                    />
                  </div>

                  <div>
                    <label>Minimum Payment</label>
                    <input
                      type="number"
                      placeholder="100"
                      value={newDebt.minimumPayment || ''}
                      onChange={(e) => setNewDebt({ ...newDebt, minimumPayment: Number(e.target.value) })}
                    />
                  </div>
                </div>

                <button onClick={handleAddDebt} className="btn btn-secondary w-full">
                  + Add Debt
                </button>
              </div>

              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="hasMortgage"
                  checked={snapshot.hasMortgage}
                  onChange={(e) => updateSnapshot({ hasMortgage: e.target.checked })}
                  className="w-5 h-5"
                />
                <label htmlFor="hasMortgage" className="mb-0">I have a mortgage (added above or planning to)</label>
              </div>
            </div>
          )}

          {/* Retirement Step */}
          {currentStep === 'retirement' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-2xl mb-2">Retirement & Investments</h2>
                <p className="text-[var(--text-muted)]">Tell us about your retirement accounts.</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label>401(k) Balance</label>
                  <input
                    type="number"
                    placeholder="25000"
                    value={snapshot.retirement401k || ''}
                    onChange={(e) => updateSnapshot({ retirement401k: Number(e.target.value) })}
                  />
                </div>

                <div>
                  <label>Roth IRA Balance</label>
                  <input
                    type="number"
                    placeholder="10000"
                    value={snapshot.rothIra || ''}
                    onChange={(e) => updateSnapshot({ rothIra: Number(e.target.value) })}
                  />
                </div>

                <div>
                  <label>HSA Balance</label>
                  <input
                    type="number"
                    placeholder="3000"
                    value={snapshot.hsa || ''}
                    onChange={(e) => updateSnapshot({ hsa: Number(e.target.value) })}
                  />
                </div>

                <div>
                  <label>Current 401(k) Contribution %</label>
                  <input
                    type="number"
                    step="1"
                    placeholder="6"
                    value={snapshot.currentContributionPercent || ''}
                    onChange={(e) => updateSnapshot({ currentContributionPercent: Number(e.target.value) })}
                  />
                </div>

                <div>
                  <label>Employer Match %</label>
                  <input
                    type="number"
                    step="0.5"
                    placeholder="4"
                    value={snapshot.employerMatchPercent || ''}
                    onChange={(e) => updateSnapshot({ employerMatchPercent: Number(e.target.value) })}
                  />
                </div>

                <div>
                  <label>Employer Match Limit ($)</label>
                  <input
                    type="number"
                    placeholder="3000"
                    value={snapshot.employerMatchLimit || ''}
                    onChange={(e) => updateSnapshot({ employerMatchLimit: Number(e.target.value) })}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Summary Step */}
          {currentStep === 'summary' && (
            <div className="space-y-6">
              <div>
                <h2 className="text-2xl mb-2">Choose Your Strategy</h2>
                <p className="text-[var(--text-muted)]">Select the approach that resonates with you.</p>
              </div>

              <div className="space-y-3">
                {STRATEGY_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setStrategy(opt.value)}
                    className={`w-full text-left p-4 rounded-lg border-2 transition-all ${
                      strategy === opt.value
                        ? 'border-[var(--gold)] bg-[var(--gold)]/10'
                        : 'border-[var(--border)] hover:border-[var(--text-dim)]'
                    }`}
                  >
                    <p className="font-semibold text-lg">{opt.label}</p>
                    <p className="text-[var(--text-muted)]">{opt.description}</p>
                  </button>
                ))}
              </div>

              {/* Quick Summary */}
              <div className="bg-[var(--background-secondary)] rounded-lg p-4 space-y-2">
                <h3 className="font-semibold mb-3">Your Financial Snapshot</h3>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="text-[var(--text-muted)]">Annual Income:</div>
                  <div>{formatCurrency(snapshot.grossAnnualIncome)}</div>

                  <div className="text-[var(--text-muted)]">Monthly Expenses:</div>
                  <div>{formatCurrency(snapshot.monthlyExpenses)}</div>

                  <div className="text-[var(--text-muted)]">Total Savings:</div>
                  <div>{formatCurrency(snapshot.emergencyFund + snapshot.checkingBalance + snapshot.liquidCash)}</div>

                  <div className="text-[var(--text-muted)]">Total Debt:</div>
                  <div className="text-[var(--danger)]">
                    {formatCurrency(snapshot.debts.reduce((sum, d) => sum + d.balance, 0))}
                  </div>

                  <div className="text-[var(--text-muted)]">Retirement:</div>
                  <div>{formatCurrency(snapshot.retirement401k + snapshot.rothIra + snapshot.hsa)}</div>
                </div>
              </div>
            </div>
          )}

          {/* Navigation Buttons */}
          <div className="flex justify-between mt-8">
            <button
              onClick={prevStep}
              disabled={stepIndex === 0}
              className="btn btn-secondary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Back
            </button>

            {currentStep === 'summary' ? (
              <button onClick={onComplete} className="btn btn-primary">
                View My Roadmap
              </button>
            ) : (
              <button onClick={nextStep} className="btn btn-primary">
                Continue
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
