'use client';

import { useState } from 'react';
import { useFinancialStore } from '@/lib/store/financialStore';
import { Debt, DebtCategory } from '@/types/financial';

export default function InputCards({ onComplete }: { onComplete: () => void }) {
  const {
    snapshot,
    updateSnapshot,
    currentAge,
    setAge,
    targetRetirementAge,
    setTargetRetirementAge,
    addDebt,
    removeDebt,
  } = useFinancialStore();

  const [showDebtForm, setShowDebtForm] = useState(false);
  const [newDebt, setNewDebt] = useState({ name: '', balance: '', rate: '' });

  const handleAddDebt = () => {
    if (newDebt.name && newDebt.balance) {
      addDebt({
        id: crypto.randomUUID(),
        name: newDebt.name,
        balance: Number(newDebt.balance),
        interestRate: Number(newDebt.rate) || 0,
        minimumPayment: 0,
        category: 'OTHER' as DebtCategory,
      });
      setNewDebt({ name: '', balance: '', rate: '' });
      setShowDebtForm(false);
    }
  };

  const formatCurrency = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);

  const isReady = snapshot.grossAnnualIncome > 0 && snapshot.monthlyExpenses > 0;

  return (
    <div className="min-h-screen p-6 md:p-12">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="mb-3">Financial GPS</h1>
          <p className="text-secondary text-lg">Your personal money roadmap</p>
        </div>

        {/* 4 Input Cards Grid */}
        <div className="grid md:grid-cols-2 gap-6 mb-8">
          {/* Card 1: Income */}
          <div className="card">
            <h3 className="mb-6 text-secondary">Income</h3>
            <div className="space-y-5">
              <div>
                <label>Annual Income</label>
                <input
                  type="number"
                  placeholder="75,000"
                  value={snapshot.grossAnnualIncome || ''}
                  onChange={(e) => updateSnapshot({ grossAnnualIncome: Number(e.target.value) })}
                />
              </div>
              <div>
                <label>Monthly Take-Home</label>
                <input
                  type="number"
                  placeholder="4,500"
                  value={snapshot.monthlyTakeHome || ''}
                  onChange={(e) => updateSnapshot({ monthlyTakeHome: Number(e.target.value) })}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label>Your Age</label>
                  <input
                    type="number"
                    placeholder="30"
                    value={currentAge || ''}
                    onChange={(e) => setAge(Number(e.target.value))}
                  />
                </div>
                <div>
                  <label>Retire At</label>
                  <input
                    type="number"
                    placeholder="65"
                    value={targetRetirementAge || ''}
                    onChange={(e) => setTargetRetirementAge(Number(e.target.value))}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Card 2: Spending */}
          <div className="card">
            <h3 className="mb-6 text-secondary">Spending</h3>
            <div className="space-y-5">
              <div>
                <label>Monthly Expenses</label>
                <input
                  type="number"
                  placeholder="3,500"
                  value={snapshot.monthlyExpenses || ''}
                  onChange={(e) => updateSnapshot({ monthlyExpenses: Number(e.target.value) })}
                />
              </div>
              <div>
                <label>Emergency Fund</label>
                <input
                  type="number"
                  placeholder="10,000"
                  value={snapshot.emergencyFund || ''}
                  onChange={(e) => updateSnapshot({ emergencyFund: Number(e.target.value) })}
                />
              </div>
            </div>
          </div>

          {/* Card 3: Debts */}
          <div className="card">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-secondary mb-0">Debts</h3>
              {snapshot.debts.length > 0 && (
                <span className="text-gold font-semibold">
                  {formatCurrency(snapshot.debts.reduce((s, d) => s + d.balance, 0))}
                </span>
              )}
            </div>

            {snapshot.debts.length === 0 && !showDebtForm && (
              <p className="text-dim mb-4">No debts added</p>
            )}

            {/* Debt List */}
            {snapshot.debts.length > 0 && (
              <div className="space-y-3 mb-4">
                {snapshot.debts.map((debt) => (
                  <div
                    key={debt.id}
                    className="flex items-center justify-between p-3 bg-[var(--background-input)] rounded-xl"
                  >
                    <div>
                      <p className="font-medium">{debt.name}</p>
                      <p className="text-sm text-secondary">
                        {formatCurrency(debt.balance)} · {debt.interestRate}%
                      </p>
                    </div>
                    <button
                      onClick={() => removeDebt(debt.id)}
                      className="text-dim hover:text-danger p-2"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add Debt Form */}
            {showDebtForm ? (
              <div className="space-y-3">
                <input
                  type="text"
                  placeholder="Debt name"
                  value={newDebt.name}
                  onChange={(e) => setNewDebt({ ...newDebt, name: e.target.value })}
                />
                <div className="grid grid-cols-2 gap-3">
                  <input
                    type="number"
                    placeholder="Balance"
                    value={newDebt.balance}
                    onChange={(e) => setNewDebt({ ...newDebt, balance: e.target.value })}
                  />
                  <input
                    type="number"
                    placeholder="Rate %"
                    value={newDebt.rate}
                    onChange={(e) => setNewDebt({ ...newDebt, rate: e.target.value })}
                  />
                </div>
                <div className="flex gap-2">
                  <button onClick={handleAddDebt} className="btn btn-primary flex-1">
                    Add
                  </button>
                  <button onClick={() => setShowDebtForm(false)} className="btn btn-ghost">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowDebtForm(true)}
                className="btn btn-secondary w-full"
              >
                + Add Debt
              </button>
            )}
          </div>

          {/* Card 4: Investments */}
          <div className="card">
            <h3 className="mb-6 text-secondary">Investments</h3>
            <div className="space-y-5">
              <div>
                <label>Retirement Balance</label>
                <input
                  type="number"
                  placeholder="50,000"
                  value={snapshot.retirementBalance || ''}
                  onChange={(e) => updateSnapshot({ retirementBalance: Number(e.target.value) })}
                />
              </div>
              <div>
                <label>Contribution %</label>
                <input
                  type="number"
                  placeholder="10"
                  value={snapshot.contributionPercent || ''}
                  onChange={(e) => updateSnapshot({ contributionPercent: Number(e.target.value) })}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Continue Button */}
        <div className="text-center">
          <button
            onClick={onComplete}
            disabled={!isReady}
            className="btn btn-primary px-12 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            View My Roadmap
          </button>
          {!isReady && (
            <p className="text-dim text-sm mt-3">Enter income and expenses to continue</p>
          )}
        </div>
      </div>
    </div>
  );
}
