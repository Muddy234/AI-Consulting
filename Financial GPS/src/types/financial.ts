import Decimal from 'decimal.js';

// Strategy types
export type StrategyType = 'RAMSEY' | 'FIRE' | 'FOO';

// Debt categories (simplified)
export type DebtCategory = 'CREDIT_CARD' | 'AUTO' | 'STUDENT' | 'MORTGAGE' | 'OTHER';

// Financial action identifiers
export type FinancialAction =
  | 'BUDGET_ESSENTIALS'
  | 'STARTER_EMERGENCY_FUND'
  | 'EMPLOYER_MATCH'
  | 'HIGH_INTEREST_DEBT'
  | 'MODERATE_INTEREST_DEBT'
  | 'FULL_EMERGENCY_FUND'
  | 'HSA'
  | 'ROTH_IRA'
  | 'RETIREMENT_CONTRIBUTION'
  | 'MAX_RETIREMENT'
  | 'CHILDREN_COLLEGE'
  | 'TAXABLE_INVESTING'
  | 'PAY_OFF_MORTGAGE'
  | 'LOW_INTEREST_DEBT';

// Step status
export type StepStatus = 'COMPLETED' | 'IN_PROGRESS' | 'NOT_STARTED' | 'NOT_APPLICABLE';

// Simplified Debt record
export interface Debt {
  id: string;
  name: string;
  balance: number;
  interestRate: number;
  minimumPayment: number;
  category: DebtCategory;
}

// Simplified Financial Snapshot
export interface FinancialSnapshot {
  // Income
  grossAnnualIncome: number;
  monthlyTakeHome: number;

  // Spending & Savings
  monthlyExpenses: number;
  emergencyFund: number;

  // Debts
  debts: Debt[];

  // Investments (simplified - just totals)
  retirementBalance: number;
  contributionPercent: number;
}

// Step with metadata for display
export interface FinancialStep {
  action: FinancialAction;
  rank: number;
  title: string;
  description: string;
  status: StepStatus;
  progress?: number;
  targetAmount?: number;
  currentAmount?: number;
  isDebtStep: boolean;
}

// Strategy interface
export interface FinancialStrategy {
  type: StrategyType;
  name: string;
  tagline: string;
  getSteps(snapshot: FinancialSnapshot): FinancialStep[];
  getNextStep(snapshot: FinancialSnapshot): FinancialStep | null;
  sortDebts(debts: Debt[]): Debt[];
  calculateLiquidity(snapshot: FinancialSnapshot): Decimal;
}

// User profile
export interface UserProfile {
  currentAge: number;
  targetRetirementAge: number;
  strategy: StrategyType;
  snapshot: FinancialSnapshot;
}

// Helper to create default snapshot
export const createDefaultSnapshot = (): FinancialSnapshot => ({
  grossAnnualIncome: 0,
  monthlyTakeHome: 0,
  monthlyExpenses: 0,
  emergencyFund: 0,
  debts: [],
  retirementBalance: 0,
  contributionPercent: 0,
});
