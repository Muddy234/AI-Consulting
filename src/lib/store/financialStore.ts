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
  currentAge: number;
  targetRetirementAge: number;
  strategy: StrategyType;
  snapshot: FinancialSnapshot;

  // Computed
  currentSteps: FinancialStep[];
  nextStep: FinancialStep | null;

  // Actions
  setStrategy: (strategy: StrategyType) => void;
  setAge: (age: number) => void;
  setTargetRetirementAge: (age: number) => void;
  updateSnapshot: (updates: Partial<FinancialSnapshot>) => void;
  addDebt: (debt: Debt) => void;
  updateDebt: (id: string, updates: Partial<Debt>) => void;
  removeDebt: (id: string) => void;
  resetAll: () => void;
  recalculate: () => void;
}

const calculateSteps = (strategy: StrategyType, snapshot: FinancialSnapshot) => {
  const engine = getStrategy(strategy);
  const steps = engine.getSteps(snapshot);
  const nextStep = engine.getNextStep(snapshot);
  return { steps, nextStep };
};

export const useFinancialStore = create<FinancialState>()(
  persist(
    (set, get) => ({
      currentAge: 30,
      targetRetirementAge: 65,
      strategy: 'FOO',
      snapshot: createDefaultSnapshot(),
      currentSteps: [],
      nextStep: null,

      setStrategy: (strategy) => {
        const { snapshot } = get();
        const { steps, nextStep } = calculateSteps(strategy, snapshot);
        set({ strategy, currentSteps: steps, nextStep });
      },

      setAge: (age) => set({ currentAge: age }),

      setTargetRetirementAge: (age) => set({ targetRetirementAge: age }),

      updateSnapshot: (updates) => {
        const { strategy, snapshot } = get();
        const newSnapshot = { ...snapshot, ...updates };
        const { steps, nextStep } = calculateSteps(strategy, newSnapshot);
        set({ snapshot: newSnapshot, currentSteps: steps, nextStep });
      },

      addDebt: (debt) => {
        const { strategy, snapshot } = get();
        const newDebts = [...snapshot.debts, debt];
        const newSnapshot = { ...snapshot, debts: newDebts };
        const { steps, nextStep } = calculateSteps(strategy, newSnapshot);
        set({ snapshot: newSnapshot, currentSteps: steps, nextStep });
      },

      updateDebt: (id, updates) => {
        const { strategy, snapshot } = get();
        const newDebts = snapshot.debts.map(d =>
          d.id === id ? { ...d, ...updates } : d
        );
        const newSnapshot = { ...snapshot, debts: newDebts };
        const { steps, nextStep } = calculateSteps(strategy, newSnapshot);
        set({ snapshot: newSnapshot, currentSteps: steps, nextStep });
      },

      removeDebt: (id) => {
        const { strategy, snapshot } = get();
        const newDebts = snapshot.debts.filter(d => d.id !== id);
        const newSnapshot = { ...snapshot, debts: newDebts };
        const { steps, nextStep } = calculateSteps(strategy, newSnapshot);
        set({ snapshot: newSnapshot, currentSteps: steps, nextStep });
      },

      resetAll: () => {
        const defaultSnapshot = createDefaultSnapshot();
        const { steps, nextStep } = calculateSteps('FOO', defaultSnapshot);
        set({
          currentAge: 30,
          targetRetirementAge: 65,
          strategy: 'FOO',
          snapshot: defaultSnapshot,
          currentSteps: steps,
          nextStep,
        });
      },

      recalculate: () => {
        const { strategy, snapshot } = get();
        const { steps, nextStep } = calculateSteps(strategy, snapshot);
        set({ currentSteps: steps, nextStep });
      },
    }),
    {
      name: 'financial-gps-storage',
      partialize: (state) => ({
        currentAge: state.currentAge,
        targetRetirementAge: state.targetRetirementAge,
        strategy: state.strategy,
        snapshot: state.snapshot,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.recalculate();
        }
      },
    }
  )
);
