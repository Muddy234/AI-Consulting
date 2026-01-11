'use client';

import { useState, useEffect } from 'react';
import { useFinancialStore } from '@/lib/store/financialStore';
import InputCards from '@/components/InputCards';
import Dashboard from '@/components/Dashboard';

export default function Home() {
  const [view, setView] = useState<'loading' | 'input' | 'dashboard'>('loading');
  const { snapshot, _hasHydrated } = useFinancialStore();

  // Wait for hydration, then decide which view to show
  useEffect(() => {
    if (_hasHydrated) {
      if (snapshot.grossAnnualIncome > 0) {
        setView('dashboard');
      } else {
        setView('input');
      }
    }
  }, [_hasHydrated, snapshot.grossAnnualIncome]);

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
