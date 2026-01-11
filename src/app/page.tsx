'use client';

import { useState, useEffect } from 'react';
import { useFinancialStore } from '@/lib/store/financialStore';
import InputCards from '@/components/InputCards';
import Dashboard from '@/components/Dashboard';

export default function Home() {
  const [view, setView] = useState<'loading' | 'input' | 'dashboard'>('loading');
  const { snapshot, recalculate } = useFinancialStore();

  useEffect(() => {
    recalculate();
    if (snapshot.grossAnnualIncome > 0) {
      setView('dashboard');
    } else {
      setView('input');
    }
  }, []);

  useEffect(() => {
    if (view === 'loading' && snapshot.grossAnnualIncome > 0) {
      setView('dashboard');
    }
  }, [snapshot.grossAnnualIncome, view]);

  if (view === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center animate-in">
          <h1 className="text-2xl mb-2">Financial GPS</h1>
          <p className="text-secondary">Loading...</p>
        </div>
      </div>
    );
  }

  if (view === 'input') {
    return <InputCards onComplete={() => setView('dashboard')} />;
  }

  return <Dashboard onEdit={() => setView('input')} />;
}
