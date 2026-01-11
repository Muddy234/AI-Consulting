'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  createDefaultSnapshot,
  Debt,
  FinancialSnapshot,
  FinancialStep,
  StrategyType,
} from '@/types/financial';
import { getStrategy } from '@/lib/engine/strategies';

interface FinancialState {
  // User data
  birthYear: number;
  strategy: StrategyType;
  snapshot: FinancialSnapshot;

  // Computed (cached for performance)
  currentSteps: FinancialStep[];
  nextStep: FinancialStep | null;

  // Actions
  setStrategy: (strategy: StrategyType) => void;
  setBirthYear: (year: number) => void;
  updateSnapshot: (updates: Partial<FinancialSnapshot>) => void;
  addDebt: (debt: Debt) => void;
  updateDebt: (id: string, updates: Partial<Debt>) => void;
  removeDebt: (id: string) => void;
  resetAll: () => void;
  recalculate: () => void;
}

// Helper to recalculate steps
const calculateSteps = (strategy: StrategyType, snapshot: FinancialSnapshot) => {
  const engine = getStrategy(strategy);
  const steps = engine.getSteps(snapshot);
  const nextStep = engine.getNextStep(snapshot);
  return { steps, nextStep };
};

export const useFinancialStore = create<FinancialState>()(
  persist(
    (set, get) => ({
      // Initial state
      birthYear: 1990,
      strategy: 'FOO',
      snapshot: createDefaultSnapshot(),
      currentSteps: [],
      nextStep: null,

      // Set strategy and recalculate
      setStrategy: (strategy) => {
        const { snapshot } = get();
        const { steps, nextStep } = calculateSteps(strategy, snapshot);
        set({ strategy, currentSteps: steps, nextStep });
      },

      // Set birth year
      setBirthYear: (year) => set({ birthYear: year }),

      // Update snapshot and recalculate
      updateSnapshot: (updates) => {
        const { strategy, snapshot } = get();
        const newSnapshot = { ...snapshot, ...updates };
        const { steps, nextStep } = calculateSteps(strategy, newSnapshot);
        set({ snapshot: newSnapshot, currentSteps: steps, nextStep });
      },

      // Add a debt
      addDebt: (debt) => {
        const { strategy, snapshot } = get();
        const newDebts = [...snapshot.debts, debt];
        const newSnapshot = { ...snapshot, debts: newDebts };
        const { steps, nextStep } = calculateSteps(strategy, newSnapshot);
        set({ snapshot: newSnapshot, currentSteps: steps, nextStep });
      },

      // Update a debt
      updateDebt: (id, updates) => {
        const { strategy, snapshot } = get();
        const newDebts = snapshot.debts.map(d =>
          d.id === id ? { ...d, ...updates } : d
        );
        const newSnapshot = { ...snapshot, debts: newDebts };
        const { steps, nextStep } = calculateSteps(strategy, newSnapshot);
        set({ snapshot: newSnapshot, currentSteps: steps, nextStep });
      },

      // Remove a debt
      removeDebt: (id) => {
        const { strategy, snapshot } = get();
        const newDebts = snapshot.debts.filter(d => d.id !== id);
        const newSnapshot = { ...snapshot, debts: newDebts };
        const { steps, nextStep } = calculateSteps(strategy, newSnapshot);
        set({ snapshot: newSnapshot, currentSteps: steps, nextStep });
      },

      // Reset everything
      resetAll: () => {
        const defaultSnapshot = createDefaultSnapshot();
        const { steps, nextStep } = calculateSteps('FOO', defaultSnapshot);
        set({
          birthYear: 1990,
          strategy: 'FOO',
          snapshot: defaultSnapshot,
          currentSteps: steps,
          nextStep,
        });
      },

      // Manual recalculation trigger
      recalculate: () => {
        const { strategy, snapshot } = get();
        const { steps, nextStep } = calculateSteps(strategy, snapshot);
        set({ currentSteps: steps, nextStep });
      },
    }),
    {
      name: 'financial-gps-storage',
      // Only persist user data, not computed values
      partialize: (state) => ({
        birthYear: state.birthYear,
        strategy: state.strategy,
        snapshot: state.snapshot,
      }),
      // Recalculate on hydration
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.recalculate();
        }
      },
    }
  )
);
