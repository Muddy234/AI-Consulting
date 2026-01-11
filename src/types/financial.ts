import Decimal from 'decimal.js';

// Strategy types
export type StrategyType = 'RAMSEY' | 'FIRE' | 'FOO';

// Debt categories
export type DebtCategory = 'MORTGAGE' | 'AUTO' | 'STUDENT' | 'CREDIT_CARD' | 'PERSONAL' | 'OTHER';

// Financial action identifiers
export type FinancialAction =
  | 'BUDGET_ESSENTIALS'
  | 'STARTER_EMERGENCY_FUND'
  | 'EMPLOYER_MATCH'
  | 'HIGH_INTEREST_DEBT'      // >7%
  | 'MODERATE_INTEREST_DEBT'   // 4-7%
  | 'FULL_EMERGENCY_FUND'
  | 'HSA'
  | 'ROTH_IRA'
  | 'RETIREMENT_CONTRIBUTION'  // 15% Ramsey / 25% FOO / Max FIRE
  | 'MAX_RETIREMENT'           // Max 401k space
  | 'CHILDREN_COLLEGE'
  | 'TAXABLE_INVESTING'
  | 'PAY_OFF_MORTGAGE'
  | 'LOW_INTEREST_DEBT';       // <4%

// Step status
export type StepStatus = 'COMPLETED' | 'IN_PROGRESS' | 'NOT_STARTED' | 'NOT_APPLICABLE';

// Debt record
export interface Debt {
  id: string;
  name: string;
  balance: number;          // Stored as number, converted to Decimal for calculations
  interestRate: number;     // As percentage (e.g., 6.5 for 6.5%)
  minimumPayment: number;
  category: DebtCategory;
}

// User's financial snapshot
export interface FinancialSnapshot {
  // Income
  grossAnnualIncome: number;
  monthlyTakeHome: number;

  // Expenses
  monthlyExpenses: number;

  // Assets
  liquidCash: number;
  emergencyFund: number;
  checkingBalance: number;

  // Investments
  retirement401k: number;
  rothIra: number;
  hsa: number;
  taxableBrokerage: number;

  // Employer benefits
  employerMatchPercent: number;     // e.g., 4 for 4%
  employerMatchLimit: number;       // Max employer will match
  currentContributionPercent: number;

  // Insurance
  highestDeductible: number;

  // Debts
  debts: Debt[];

  // Life situation
  hasChildren: boolean;
  hasMortgage: boolean;
}

// Step with metadata for display
export interface FinancialStep {
  action: FinancialAction;
  rank: number;
  title: string;
  description: string;
  status: StepStatus;
  progress?: number;          // 0-100 percentage
  targetAmount?: number;
  currentAmount?: number;
  isDebtStep: boolean;        // For color coding (red for debt, green for wealth)
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

// Benchmark data for "Joneses" comparison
export interface BenchmarkData {
  ageGroup: string;
  medianNetWorth: number;
  top10NetWorth: number;
  medianIncome: number;
  avgDebtToIncome: number;
}

// User profile
export interface UserProfile {
  birthYear: number;
  strategy: StrategyType;
  snapshot: FinancialSnapshot;
}

// Helper to create default snapshot
export const createDefaultSnapshot = (): FinancialSnapshot => ({
  grossAnnualIncome: 0,
  monthlyTakeHome: 0,
  monthlyExpenses: 0,
  liquidCash: 0,
  emergencyFund: 0,
  checkingBalance: 0,
  retirement401k: 0,
  rothIra: 0,
  hsa: 0,
  taxableBrokerage: 0,
  employerMatchPercent: 0,
  employerMatchLimit: 0,
  currentContributionPercent: 0,
  highestDeductible: 0,
  debts: [],
  hasChildren: false,
  hasMortgage: false,
});
