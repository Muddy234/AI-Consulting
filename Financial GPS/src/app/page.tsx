'use client';

import { useState, useEffect, useRef } from 'react';
import { useFinancialStore } from '@/lib/store/financialStore';
import InputCards from '@/components/InputCards';
import Dashboard from '@/components/Dashboard';

export default function Home() {
  const [view, setView] = useState<'loading' | 'input' | 'dashboard'>('loading');
  const { snapshot, _hasHydrated } = useFinancialStore();
  const initialViewSet = useRef(false);

  // Wait for hydration, then decide initial view based on existing data
  // Only runs once when hydration completes
  useEffect(() => {
    if (_hasHydrated && !initialViewSet.current) {
      initialViewSet.current = true;
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
