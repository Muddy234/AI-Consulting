import Decimal from 'decimal.js';
import {
  Debt,
  FinancialAction,
  FinancialSnapshot,
  FinancialStep,
  FinancialStrategy,
  StepStatus,
  StrategyType,
} from '@/types/financial';
import { STRATEGY_RANKINGS, STEP_METADATA } from './rankings';

// Configure Decimal.js for financial precision
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

// Constants
const STARTER_EMERGENCY_FUND = 2000;
const VOLATILITY_DISCOUNT = 0.70;

// Helper: Convert number to Decimal
const toDecimal = (n: number): Decimal => new Decimal(n || 0);

// Helper: Get non-mortgage debts
const getNonMortgageDebt = (debts: Debt[]): Debt[] => {
  return debts.filter(d => d.category !== 'MORTGAGE');
};

// Helper: Get debts by interest rate threshold
const getDebtsByRate = (debts: Debt[], minRate: number, maxRate?: number): Debt[] => {
  return debts.filter(d => {
    if (d.category === 'MORTGAGE') return false;
    if (maxRate !== undefined) {
      return d.interestRate >= minRate && d.interestRate < maxRate;
    }
    return d.interestRate >= minRate;
  });
};

// Helper: Calculate total debt balance
const getTotalDebtBalance = (debts: Debt[]): Decimal => {
  return debts.reduce((sum, d) => sum.plus(toDecimal(d.balance)), toDecimal(0));
};

// Base class with shared logic
abstract class BaseStrategy implements FinancialStrategy {
  abstract type: StrategyType;
  abstract name: string;
  abstract tagline: string;
  abstract sortDebts(debts: Debt[]): Debt[];

  calculateLiquidity(snapshot: FinancialSnapshot): Decimal {
    return toDecimal(snapshot.emergencyFund);
  }

  getSteps(snapshot: FinancialSnapshot): FinancialStep[] {
    const rankings = STRATEGY_RANKINGS[this.type];
    const actions = Object.keys(rankings) as FinancialAction[];

    const steps = actions.map(action => {
      const status = this.getStepStatus(action, snapshot);
      const metadata = STEP_METADATA[action];
      const { targetAmount, currentAmount } = this.getStepAmounts(action, snapshot);

      let progress: number | undefined;
      if (targetAmount !== undefined && currentAmount !== undefined && targetAmount > 0) {
        progress = Math.min(100, Math.round((currentAmount / targetAmount) * 100));
      }

      return {
        action,
        rank: rankings[action],
        title: metadata.title,
        description: metadata.descriptions[this.type],
        status,
        progress,
        targetAmount,
        currentAmount,
        isDebtStep: metadata.isDebtStep,
      };
    });

    return steps.sort((a, b) => a.rank - b.rank);
  }

  getNextStep(snapshot: FinancialSnapshot): FinancialStep | null {
    const steps = this.getSteps(snapshot);
    return steps.find(s => s.status === 'IN_PROGRESS' || s.status === 'NOT_STARTED') || null;
  }

  protected abstract getStepStatus(action: FinancialAction, snapshot: FinancialSnapshot): StepStatus;
  protected abstract getStepAmounts(action: FinancialAction, snapshot: FinancialSnapshot): {
    targetAmount?: number;
    currentAmount?: number;
  };
}

// RAMSEY STRATEGY
export class RamseyStrategy extends BaseStrategy {
  type: StrategyType = 'RAMSEY';
  name = 'Dave Ramsey';
  tagline = 'Debt-free focus';

  sortDebts(debts: Debt[]): Debt[] {
    const nonMortgage = getNonMortgageDebt(debts);
    return [...nonMortgage].sort((a, b) => a.balance - b.balance);
  }

  protected getStepStatus(action: FinancialAction, snapshot: FinancialSnapshot): StepStatus {
    const monthlyExpenses = toDecimal(snapshot.monthlyExpenses);
    const emergencyFund = toDecimal(snapshot.emergencyFund);
    const nonMortgageDebt = getTotalDebtBalance(getNonMortgageDebt(snapshot.debts));
    const grossMonthly = toDecimal(snapshot.grossAnnualIncome).dividedBy(12);
    const targetRetirement = grossMonthly.times(0.15);
    const currentRetirement = toDecimal(snapshot.contributionPercent).times(grossMonthly).dividedBy(100);

    switch (action) {
      case 'BUDGET_ESSENTIALS':
        return snapshot.grossAnnualIncome > 0 && snapshot.monthlyExpenses > 0 ? 'COMPLETED' : 'IN_PROGRESS';

      case 'STARTER_EMERGENCY_FUND':
        if (emergencyFund.gte(STARTER_EMERGENCY_FUND)) return 'COMPLETED';
        return emergencyFund.gt(0) ? 'IN_PROGRESS' : 'NOT_STARTED';

      case 'HIGH_INTEREST_DEBT':
      case 'MODERATE_INTEREST_DEBT':
      case 'LOW_INTEREST_DEBT':
        if (nonMortgageDebt.eq(0)) return 'COMPLETED';
        if (emergencyFund.lt(STARTER_EMERGENCY_FUND)) return 'NOT_STARTED';
        return 'IN_PROGRESS';

      case 'FULL_EMERGENCY_FUND':
        const targetEmergency = monthlyExpenses.times(6);
        if (emergencyFund.gte(targetEmergency)) return 'COMPLETED';
        if (nonMortgageDebt.gt(0)) return 'NOT_STARTED';
        return emergencyFund.gte(monthlyExpenses.times(3)) ? 'IN_PROGRESS' : 'NOT_STARTED';

      case 'EMPLOYER_MATCH':
      case 'HSA':
      case 'ROTH_IRA':
      case 'RETIREMENT_CONTRIBUTION':
        if (nonMortgageDebt.gt(0)) return 'NOT_STARTED';
        if (emergencyFund.lt(monthlyExpenses.times(3))) return 'NOT_STARTED';
        if (currentRetirement.gte(targetRetirement)) return 'COMPLETED';
        return currentRetirement.gt(0) ? 'IN_PROGRESS' : 'NOT_STARTED';

      case 'CHILDREN_COLLEGE':
      case 'PAY_OFF_MORTGAGE':
      case 'MAX_RETIREMENT':
      case 'TAXABLE_INVESTING':
        if (currentRetirement.lt(targetRetirement)) return 'NOT_STARTED';
        return 'IN_PROGRESS';

      default:
        return 'NOT_STARTED';
    }
  }

  protected getStepAmounts(action: FinancialAction, snapshot: FinancialSnapshot) {
    switch (action) {
      case 'STARTER_EMERGENCY_FUND':
        return { targetAmount: STARTER_EMERGENCY_FUND, currentAmount: Math.min(snapshot.emergencyFund, STARTER_EMERGENCY_FUND) };
      case 'FULL_EMERGENCY_FUND':
        return { targetAmount: snapshot.monthlyExpenses * 6, currentAmount: snapshot.emergencyFund };
      case 'RETIREMENT_CONTRIBUTION':
        const target = (snapshot.grossAnnualIncome / 12) * 0.15;
        const current = (snapshot.contributionPercent / 100) * (snapshot.grossAnnualIncome / 12);
        return { targetAmount: target, currentAmount: current };
      default:
        return {};
    }
  }
}

// FIRE STRATEGY
export class FireStrategy extends BaseStrategy {
  type: StrategyType = 'FIRE';
  name = 'FIRE';
  tagline = 'Math-optimized';

  sortDebts(debts: Debt[]): Debt[] {
    const nonMortgage = getNonMortgageDebt(debts);
    return [...nonMortgage].sort((a, b) => b.interestRate - a.interestRate);
  }

  protected getStepStatus(action: FinancialAction, snapshot: FinancialSnapshot): StepStatus {
    const monthlyExpenses = toDecimal(snapshot.monthlyExpenses);
    const emergencyFund = toDecimal(snapshot.emergencyFund);
    const highInterestDebt = getTotalDebtBalance(getDebtsByRate(snapshot.debts, 7));

    switch (action) {
      case 'BUDGET_ESSENTIALS':
        return snapshot.grossAnnualIncome > 0 && snapshot.monthlyExpenses > 0 ? 'COMPLETED' : 'IN_PROGRESS';

      case 'STARTER_EMERGENCY_FUND':
        if (emergencyFund.gte(monthlyExpenses)) return 'COMPLETED';
        return emergencyFund.gt(0) ? 'IN_PROGRESS' : 'NOT_STARTED';

      case 'EMPLOYER_MATCH':
        return snapshot.contributionPercent > 0 ? 'COMPLETED' : 'NOT_STARTED';

      case 'HIGH_INTEREST_DEBT':
        if (highInterestDebt.eq(0)) return 'COMPLETED';
        return 'IN_PROGRESS';

      case 'HSA':
      case 'ROTH_IRA':
        return snapshot.retirementBalance > 0 ? 'IN_PROGRESS' : 'NOT_STARTED';

      case 'FULL_EMERGENCY_FUND':
        if (emergencyFund.gte(monthlyExpenses.times(6))) return 'COMPLETED';
        return emergencyFund.gte(monthlyExpenses.times(3)) ? 'IN_PROGRESS' : 'NOT_STARTED';

      case 'MODERATE_INTEREST_DEBT':
        const modDebt = getTotalDebtBalance(getDebtsByRate(snapshot.debts, 4, 7));
        return modDebt.eq(0) ? 'COMPLETED' : 'IN_PROGRESS';

      case 'MAX_RETIREMENT':
      case 'RETIREMENT_CONTRIBUTION':
      case 'TAXABLE_INVESTING':
        return snapshot.retirementBalance > 0 ? 'IN_PROGRESS' : 'NOT_STARTED';

      case 'CHILDREN_COLLEGE':
      case 'PAY_OFF_MORTGAGE':
      case 'LOW_INTEREST_DEBT':
        return 'NOT_APPLICABLE';

      default:
        return 'NOT_STARTED';
    }
  }

  protected getStepAmounts(action: FinancialAction, snapshot: FinancialSnapshot) {
    switch (action) {
      case 'STARTER_EMERGENCY_FUND':
        return { targetAmount: snapshot.monthlyExpenses, currentAmount: Math.min(snapshot.emergencyFund, snapshot.monthlyExpenses) };
      case 'FULL_EMERGENCY_FUND':
        return { targetAmount: snapshot.monthlyExpenses * 6, currentAmount: snapshot.emergencyFund };
      default:
        return {};
    }
  }
}

// FOO (MONEY GUY) STRATEGY
export class FooStrategy extends BaseStrategy {
  type: StrategyType = 'FOO';
  name = 'Money Guy';
  tagline = 'Balanced approach';

  sortDebts(debts: Debt[]): Debt[] {
    const badDebt = debts.filter(d => d.category !== 'MORTGAGE' && d.interestRate > 6);
    return [...badDebt].sort((a, b) => b.interestRate - a.interestRate);
  }

  protected getStepStatus(action: FinancialAction, snapshot: FinancialSnapshot): StepStatus {
    const monthlyExpenses = toDecimal(snapshot.monthlyExpenses);
    const emergencyFund = toDecimal(snapshot.emergencyFund);
    const highInterestDebt = getTotalDebtBalance(getDebtsByRate(snapshot.debts, 6));
    const savingsRate = toDecimal(snapshot.contributionPercent);

    switch (action) {
      case 'BUDGET_ESSENTIALS':
        return snapshot.grossAnnualIncome > 0 && snapshot.monthlyExpenses > 0 ? 'COMPLETED' : 'IN_PROGRESS';

      case 'STARTER_EMERGENCY_FUND':
        if (emergencyFund.gte(1000)) return 'COMPLETED';
        return emergencyFund.gt(0) ? 'IN_PROGRESS' : 'NOT_STARTED';

      case 'EMPLOYER_MATCH':
        return snapshot.contributionPercent > 0 ? 'COMPLETED' : 'NOT_STARTED';

      case 'HIGH_INTEREST_DEBT':
        if (highInterestDebt.eq(0)) return 'COMPLETED';
        return 'IN_PROGRESS';

      case 'FULL_EMERGENCY_FUND':
        if (emergencyFund.gte(monthlyExpenses.times(6))) return 'COMPLETED';
        return emergencyFund.gte(monthlyExpenses.times(3)) ? 'IN_PROGRESS' : 'NOT_STARTED';

      case 'HSA':
      case 'ROTH_IRA':
        return snapshot.retirementBalance > 0 ? 'IN_PROGRESS' : 'NOT_STARTED';

      case 'RETIREMENT_CONTRIBUTION':
      case 'MAX_RETIREMENT':
        if (savingsRate.gte(25)) return 'COMPLETED';
        return savingsRate.gt(0) ? 'IN_PROGRESS' : 'NOT_STARTED';

      case 'TAXABLE_INVESTING':
        if (savingsRate.lt(25)) return 'NOT_STARTED';
        return 'IN_PROGRESS';

      case 'CHILDREN_COLLEGE':
      case 'MODERATE_INTEREST_DEBT':
      case 'LOW_INTEREST_DEBT':
      case 'PAY_OFF_MORTGAGE':
        if (savingsRate.lt(25)) return 'NOT_STARTED';
        return 'IN_PROGRESS';

      default:
        return 'NOT_STARTED';
    }
  }

  protected getStepAmounts(action: FinancialAction, snapshot: FinancialSnapshot) {
    switch (action) {
      case 'STARTER_EMERGENCY_FUND':
        return { targetAmount: 1000, currentAmount: Math.min(snapshot.emergencyFund, 1000) };
      case 'FULL_EMERGENCY_FUND':
        return { targetAmount: snapshot.monthlyExpenses * 6, currentAmount: snapshot.emergencyFund };
      case 'RETIREMENT_CONTRIBUTION':
        return { targetAmount: 25, currentAmount: snapshot.contributionPercent };
      default:
        return {};
    }
  }
}

// Factory function
export function getStrategy(type: StrategyType): FinancialStrategy {
  switch (type) {
    case 'RAMSEY': return new RamseyStrategy();
    case 'FIRE': return new FireStrategy();
    case 'FOO': return new FooStrategy();
    default: return new FooStrategy();
  }
}
