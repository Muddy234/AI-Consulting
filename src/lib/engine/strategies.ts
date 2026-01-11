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
const STARTER_EMERGENCY_RAMSEY = 2000;  // Inflation adjusted from $1000
const VOLATILITY_DISCOUNT = 0.70;       // For liquidity risk calculation

// Helper: Convert number to Decimal
const toDecimal = (n: number): Decimal => new Decimal(n || 0);

// Helper: Calculate monthly income from annual
const monthlyFromAnnual = (annual: number): Decimal => {
  return toDecimal(annual).dividedBy(12);
};

// Helper: Get total non-mortgage debt
const getNonMortgageDebt = (debts: Debt[]): Debt[] => {
  return debts.filter(d => d.category !== 'MORTGAGE');
};

// Helper: Get mortgage debt
const getMortgageDebt = (debts: Debt[]): Debt | undefined => {
  return debts.find(d => d.category === 'MORTGAGE');
};

// Helper: Get debts by interest rate threshold
const getDebtsByRate = (debts: Debt[], minRate: number, maxRate?: number): Debt[] => {
  return debts.filter(d => {
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

  // Calculate effective liquidity (with volatility discount on investments)
  calculateLiquidity(snapshot: FinancialSnapshot): Decimal {
    const liquid = toDecimal(snapshot.liquidCash)
      .plus(toDecimal(snapshot.emergencyFund))
      .plus(toDecimal(snapshot.checkingBalance));

    const investedWithDiscount = toDecimal(snapshot.taxableBrokerage)
      .times(VOLATILITY_DISCOUNT);

    return liquid.plus(investedWithDiscount);
  }

  // Get all steps with status
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

    // Sort by rank
    return steps.sort((a, b) => a.rank - b.rank);
  }

  // Get the next incomplete step
  getNextStep(snapshot: FinancialSnapshot): FinancialStep | null {
    const steps = this.getSteps(snapshot);
    return steps.find(s => s.status === 'IN_PROGRESS' || s.status === 'NOT_STARTED') || null;
  }

  // Get step status - to be customized by each strategy
  protected abstract getStepStatus(action: FinancialAction, snapshot: FinancialSnapshot): StepStatus;

  // Get target and current amounts for progress calculation
  protected abstract getStepAmounts(action: FinancialAction, snapshot: FinancialSnapshot): {
    targetAmount?: number;
    currentAmount?: number;
  };
}

// ============================================
// RAMSEY STRATEGY
// ============================================
export class RamseyStrategy extends BaseStrategy {
  type: StrategyType = 'RAMSEY';
  name = 'Dave Ramsey Method';
  tagline = 'Peace & Debt-Free Focus';

  // Debt Snowball: Smallest balance first
  sortDebts(debts: Debt[]): Debt[] {
    const nonMortgage = getNonMortgageDebt(debts);
    return [...nonMortgage].sort((a, b) => a.balance - b.balance);
  }

  protected getStepStatus(action: FinancialAction, snapshot: FinancialSnapshot): StepStatus {
    const monthlyExpenses = toDecimal(snapshot.monthlyExpenses);
    const emergencyFund = toDecimal(snapshot.emergencyFund).plus(toDecimal(snapshot.liquidCash));
    const nonMortgageDebt = getTotalDebtBalance(getNonMortgageDebt(snapshot.debts));
    const grossMonthly = monthlyFromAnnual(snapshot.grossAnnualIncome);
    const targetRetirement = grossMonthly.times(0.15);
    const currentRetirement = toDecimal(snapshot.currentContributionPercent).times(grossMonthly).dividedBy(100);
    const mortgage = getMortgageDebt(snapshot.debts);

    switch (action) {
      case 'BUDGET_ESSENTIALS':
        // Assume complete if they have income and expenses tracked
        return snapshot.grossAnnualIncome > 0 && snapshot.monthlyExpenses > 0 ? 'COMPLETED' : 'IN_PROGRESS';

      case 'STARTER_EMERGENCY_FUND':
        if (emergencyFund.gte(STARTER_EMERGENCY_RAMSEY)) return 'COMPLETED';
        return emergencyFund.gt(0) ? 'IN_PROGRESS' : 'NOT_STARTED';

      case 'HIGH_INTEREST_DEBT':
      case 'MODERATE_INTEREST_DEBT':
      case 'LOW_INTEREST_DEBT':
        // Ramsey treats all non-mortgage debt the same
        if (nonMortgageDebt.eq(0)) return 'COMPLETED';
        if (emergencyFund.lt(STARTER_EMERGENCY_RAMSEY)) return 'NOT_STARTED';
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
        // All part of 15% step
        if (nonMortgageDebt.gt(0)) return 'NOT_STARTED';
        if (emergencyFund.lt(monthlyExpenses.times(3))) return 'NOT_STARTED';
        if (currentRetirement.gte(targetRetirement)) return 'COMPLETED';
        return currentRetirement.gt(0) ? 'IN_PROGRESS' : 'NOT_STARTED';

      case 'CHILDREN_COLLEGE':
        if (!snapshot.hasChildren) return 'NOT_APPLICABLE';
        if (currentRetirement.lt(targetRetirement)) return 'NOT_STARTED';
        return 'IN_PROGRESS'; // Always in progress if applicable

      case 'PAY_OFF_MORTGAGE':
        if (!mortgage) return 'NOT_APPLICABLE';
        if (mortgage.balance <= 0) return 'COMPLETED';
        if (currentRetirement.lt(targetRetirement)) return 'NOT_STARTED';
        return 'IN_PROGRESS';

      case 'MAX_RETIREMENT':
      case 'TAXABLE_INVESTING':
        if (mortgage && mortgage.balance > 0) return 'NOT_STARTED';
        return 'IN_PROGRESS';

      default:
        return 'NOT_STARTED';
    }
  }

  protected getStepAmounts(action: FinancialAction, snapshot: FinancialSnapshot): {
    targetAmount?: number;
    currentAmount?: number;
  } {
    const monthlyExpenses = snapshot.monthlyExpenses;
    const emergencyFund = snapshot.emergencyFund + snapshot.liquidCash;

    switch (action) {
      case 'STARTER_EMERGENCY_FUND':
        return { targetAmount: STARTER_EMERGENCY_RAMSEY, currentAmount: Math.min(emergencyFund, STARTER_EMERGENCY_RAMSEY) };

      case 'HIGH_INTEREST_DEBT':
      case 'MODERATE_INTEREST_DEBT':
      case 'LOW_INTEREST_DEBT':
        const totalDebt = getTotalDebtBalance(getNonMortgageDebt(snapshot.debts)).toNumber();
        return { targetAmount: totalDebt, currentAmount: 0 }; // Progress is inverse

      case 'FULL_EMERGENCY_FUND':
        return { targetAmount: monthlyExpenses * 6, currentAmount: emergencyFund };

      case 'RETIREMENT_CONTRIBUTION':
        const grossMonthly = snapshot.grossAnnualIncome / 12;
        const target = grossMonthly * 0.15;
        const current = (snapshot.currentContributionPercent / 100) * grossMonthly;
        return { targetAmount: target, currentAmount: current };

      default:
        return {};
    }
  }
}

// ============================================
// FIRE STRATEGY
// ============================================
export class FireStrategy extends BaseStrategy {
  type: StrategyType = 'FIRE';
  name = 'FIRE Method';
  tagline = 'Math & Net Worth Focus';

  // Debt Avalanche: Highest interest first
  sortDebts(debts: Debt[]): Debt[] {
    const nonMortgage = getNonMortgageDebt(debts);
    return [...nonMortgage].sort((a, b) => b.interestRate - a.interestRate);
  }

  protected getStepStatus(action: FinancialAction, snapshot: FinancialSnapshot): StepStatus {
    const monthlyExpenses = toDecimal(snapshot.monthlyExpenses);
    const emergencyFund = toDecimal(snapshot.emergencyFund).plus(toDecimal(snapshot.liquidCash));
    const highInterestDebt = getTotalDebtBalance(getDebtsByRate(snapshot.debts, 7));
    const moderateDebt = getTotalDebtBalance(getDebtsByRate(snapshot.debts, 4, 7));
    const matchContribution = toDecimal(snapshot.employerMatchPercent);
    const currentContribution = toDecimal(snapshot.currentContributionPercent);

    switch (action) {
      case 'BUDGET_ESSENTIALS':
        return snapshot.grossAnnualIncome > 0 && snapshot.monthlyExpenses > 0 ? 'COMPLETED' : 'IN_PROGRESS';

      case 'STARTER_EMERGENCY_FUND':
        if (emergencyFund.gte(monthlyExpenses)) return 'COMPLETED';
        return emergencyFund.gt(0) ? 'IN_PROGRESS' : 'NOT_STARTED';

      case 'EMPLOYER_MATCH':
        if (currentContribution.gte(matchContribution)) return 'COMPLETED';
        return currentContribution.gt(0) ? 'IN_PROGRESS' : 'NOT_STARTED';

      case 'HIGH_INTEREST_DEBT':
        if (highInterestDebt.eq(0)) return 'COMPLETED';
        return 'IN_PROGRESS';

      case 'HSA':
        // HSA max is ~$4,150 for individual (2024)
        if (snapshot.hsa >= 4150) return 'COMPLETED';
        return snapshot.hsa > 0 ? 'IN_PROGRESS' : 'NOT_STARTED';

      case 'ROTH_IRA':
        // Roth max is $7,000 (2024)
        if (snapshot.rothIra >= 7000) return 'COMPLETED';
        return snapshot.rothIra > 0 ? 'IN_PROGRESS' : 'NOT_STARTED';

      case 'FULL_EMERGENCY_FUND':
        const targetEmergency = monthlyExpenses.times(6);
        if (emergencyFund.gte(targetEmergency)) return 'COMPLETED';
        return emergencyFund.gte(monthlyExpenses.times(3)) ? 'IN_PROGRESS' : 'NOT_STARTED';

      case 'MODERATE_INTEREST_DEBT':
        if (moderateDebt.eq(0)) return 'COMPLETED';
        return 'IN_PROGRESS'; // Optional per FIRE

      case 'MAX_RETIREMENT':
      case 'RETIREMENT_CONTRIBUTION':
        // 401k max is $23,000 (2024)
        if (snapshot.retirement401k >= 23000) return 'COMPLETED';
        return snapshot.retirement401k > 0 ? 'IN_PROGRESS' : 'NOT_STARTED';

      case 'TAXABLE_INVESTING':
        return snapshot.taxableBrokerage > 0 ? 'IN_PROGRESS' : 'NOT_STARTED';

      case 'CHILDREN_COLLEGE':
      case 'PAY_OFF_MORTGAGE':
        return 'IN_PROGRESS'; // Low priority for FIRE

      case 'LOW_INTEREST_DEBT':
        return 'NOT_APPLICABLE'; // FIRE says never pay extra on <4%

      default:
        return 'NOT_STARTED';
    }
  }

  protected getStepAmounts(action: FinancialAction, snapshot: FinancialSnapshot): {
    targetAmount?: number;
    currentAmount?: number;
  } {
    const monthlyExpenses = snapshot.monthlyExpenses;
    const emergencyFund = snapshot.emergencyFund + snapshot.liquidCash;

    switch (action) {
      case 'STARTER_EMERGENCY_FUND':
        return { targetAmount: monthlyExpenses, currentAmount: Math.min(emergencyFund, monthlyExpenses) };

      case 'HIGH_INTEREST_DEBT':
        const highDebt = getTotalDebtBalance(getDebtsByRate(snapshot.debts, 7)).toNumber();
        return { targetAmount: highDebt, currentAmount: 0 };

      case 'FULL_EMERGENCY_FUND':
        return { targetAmount: monthlyExpenses * 6, currentAmount: emergencyFund };

      case 'HSA':
        return { targetAmount: 4150, currentAmount: snapshot.hsa };

      case 'ROTH_IRA':
        return { targetAmount: 7000, currentAmount: snapshot.rothIra };

      case 'MAX_RETIREMENT':
        return { targetAmount: 23000, currentAmount: snapshot.retirement401k };

      default:
        return {};
    }
  }
}

// ============================================
// FOO (MONEY GUY) STRATEGY
// ============================================
export class FooStrategy extends BaseStrategy {
  type: StrategyType = 'FOO';
  name = 'Money Guy FOO Method';
  tagline = 'Hybrid & Behavior Focus';

  // Hybrid: High interest first, but respects good vs bad debt
  sortDebts(debts: Debt[]): Debt[] {
    // First, separate "bad" debt (consumer) from "good" debt (mortgage, some student)
    const badDebt = debts.filter(d =>
      d.category === 'CREDIT_CARD' ||
      d.category === 'PERSONAL' ||
      d.interestRate > 6
    );
    return [...badDebt].sort((a, b) => b.interestRate - a.interestRate);
  }

  protected getStepStatus(action: FinancialAction, snapshot: FinancialSnapshot): StepStatus {
    const monthlyExpenses = toDecimal(snapshot.monthlyExpenses);
    const emergencyFund = toDecimal(snapshot.emergencyFund).plus(toDecimal(snapshot.liquidCash));
    const highInterestDebt = getTotalDebtBalance(getDebtsByRate(snapshot.debts, 6));
    const grossAnnual = toDecimal(snapshot.grossAnnualIncome);
    const totalSavings = toDecimal(snapshot.currentContributionPercent)
      .plus(toDecimal(snapshot.hsa).dividedBy(grossAnnual).times(100))
      .plus(toDecimal(snapshot.rothIra).dividedBy(grossAnnual).times(100));
    const matchContribution = toDecimal(snapshot.employerMatchPercent);
    const currentContribution = toDecimal(snapshot.currentContributionPercent);

    switch (action) {
      case 'BUDGET_ESSENTIALS':
        return snapshot.grossAnnualIncome > 0 && snapshot.monthlyExpenses > 0 ? 'COMPLETED' : 'IN_PROGRESS';

      case 'STARTER_EMERGENCY_FUND':
        // Deductible coverage
        if (emergencyFund.gte(toDecimal(snapshot.highestDeductible))) return 'COMPLETED';
        return emergencyFund.gt(0) ? 'IN_PROGRESS' : 'NOT_STARTED';

      case 'EMPLOYER_MATCH':
        if (currentContribution.gte(matchContribution)) return 'COMPLETED';
        return currentContribution.gt(0) ? 'IN_PROGRESS' : 'NOT_STARTED';

      case 'HIGH_INTEREST_DEBT':
        if (highInterestDebt.eq(0)) return 'COMPLETED';
        return 'IN_PROGRESS';

      case 'FULL_EMERGENCY_FUND':
        const targetEmergency = monthlyExpenses.times(6);
        if (emergencyFund.gte(targetEmergency)) return 'COMPLETED';
        return emergencyFund.gte(monthlyExpenses.times(3)) ? 'IN_PROGRESS' : 'NOT_STARTED';

      case 'HSA':
        if (snapshot.hsa >= 4150) return 'COMPLETED';
        return snapshot.hsa > 0 ? 'IN_PROGRESS' : 'NOT_STARTED';

      case 'ROTH_IRA':
        if (snapshot.rothIra >= 7000) return 'COMPLETED';
        return snapshot.rothIra > 0 ? 'IN_PROGRESS' : 'NOT_STARTED';

      case 'RETIREMENT_CONTRIBUTION':
      case 'MAX_RETIREMENT':
        // Target 25% savings rate
        if (totalSavings.gte(25)) return 'COMPLETED';
        return totalSavings.gt(0) ? 'IN_PROGRESS' : 'NOT_STARTED';

      case 'TAXABLE_INVESTING':
        if (totalSavings.lt(25)) return 'NOT_STARTED';
        return snapshot.taxableBrokerage > 0 ? 'IN_PROGRESS' : 'NOT_STARTED';

      case 'CHILDREN_COLLEGE':
        if (!snapshot.hasChildren) return 'NOT_APPLICABLE';
        if (totalSavings.lt(25)) return 'NOT_STARTED';
        return 'IN_PROGRESS';

      case 'MODERATE_INTEREST_DEBT':
      case 'LOW_INTEREST_DEBT':
      case 'PAY_OFF_MORTGAGE':
        if (totalSavings.lt(25)) return 'NOT_STARTED';
        return 'IN_PROGRESS';

      default:
        return 'NOT_STARTED';
    }
  }

  protected getStepAmounts(action: FinancialAction, snapshot: FinancialSnapshot): {
    targetAmount?: number;
    currentAmount?: number;
  } {
    const emergencyFund = snapshot.emergencyFund + snapshot.liquidCash;
    const monthlyExpenses = snapshot.monthlyExpenses;

    switch (action) {
      case 'STARTER_EMERGENCY_FUND':
        return {
          targetAmount: snapshot.highestDeductible || 1000,
          currentAmount: Math.min(emergencyFund, snapshot.highestDeductible || 1000)
        };

      case 'HIGH_INTEREST_DEBT':
        const highDebt = getTotalDebtBalance(getDebtsByRate(snapshot.debts, 6)).toNumber();
        return { targetAmount: highDebt, currentAmount: 0 };

      case 'FULL_EMERGENCY_FUND':
        return { targetAmount: monthlyExpenses * 6, currentAmount: emergencyFund };

      case 'HSA':
        return { targetAmount: 4150, currentAmount: snapshot.hsa };

      case 'ROTH_IRA':
        return { targetAmount: 7000, currentAmount: snapshot.rothIra };

      case 'RETIREMENT_CONTRIBUTION':
        // 25% of gross
        const target25 = snapshot.grossAnnualIncome * 0.25;
        const currentSavings = (snapshot.currentContributionPercent / 100) * snapshot.grossAnnualIncome;
        return { targetAmount: target25, currentAmount: currentSavings };

      default:
        return {};
    }
  }
}

// Factory function to get strategy by type
export function getStrategy(type: StrategyType): FinancialStrategy {
  switch (type) {
    case 'RAMSEY':
      return new RamseyStrategy();
    case 'FIRE':
      return new FireStrategy();
    case 'FOO':
      return new FooStrategy();
    default:
      return new RamseyStrategy();
  }
}
