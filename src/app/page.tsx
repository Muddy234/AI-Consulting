'use client';

import { useState, useEffect } from 'react';
import { useFinancialStore } from '@/lib/store/financialStore';
import InputWizard from '@/components/InputWizard';
import Dashboard from '@/components/Dashboard';

export default function Home() {
  const [view, setView] = useState<'loading' | 'wizard' | 'dashboard'>('loading');
  const { snapshot, recalculate } = useFinancialStore();

  // Check if user has data on mount
  useEffect(() => {
    // Recalculate steps on mount (in case of hydration from localStorage)
    recalculate();

    // If user has entered income, show dashboard; otherwise show wizard
    if (snapshot.grossAnnualIncome > 0) {
      setView('dashboard');
    } else {
      setView('wizard');
    }
  }, []);

  // Update view when snapshot changes
  useEffect(() => {
    if (view === 'loading' && snapshot.grossAnnualIncome > 0) {
      setView('dashboard');
    }
  }, [snapshot.grossAnnualIncome, view]);

  if (view === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl mb-2">Financial GPS</h1>
          <p className="text-[var(--text-muted)]">Loading your data...</p>
        </div>
      </div>
    );
  }

  if (view === 'wizard') {
    return <InputWizard onComplete={() => setView('dashboard')} />;
  }

  return <Dashboard onEditData={() => setView('wizard')} />;
}
