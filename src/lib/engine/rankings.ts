import { FinancialAction, StrategyType } from '@/types/financial';

// The Universal Ranking Table
// Lower numbers = higher priority
// 99 = Not applicable for this strategy
export const STRATEGY_RANKINGS: Record<StrategyType, Record<FinancialAction, number>> = {
  RAMSEY: {
    BUDGET_ESSENTIALS: 1,
    STARTER_EMERGENCY_FUND: 2,    // $1,000-2,000
    EMPLOYER_MATCH: 5,            // Part of 15% in step 5
    HIGH_INTEREST_DEBT: 3,        // All non-mortgage debt (snowball)
    MODERATE_INTEREST_DEBT: 3,    // All non-mortgage debt (snowball)
    FULL_EMERGENCY_FUND: 4,       // 3-6 months
    HSA: 5,                       // Part of 15%
    ROTH_IRA: 5,                  // Part of 15%
    RETIREMENT_CONTRIBUTION: 5,   // 15% of income
    MAX_RETIREMENT: 8,            // After house paid off
    CHILDREN_COLLEGE: 6,          // ESA/529
    TAXABLE_INVESTING: 8,         // Build wealth phase
    PAY_OFF_MORTGAGE: 7,          // Pay off home early
    LOW_INTEREST_DEBT: 3,         // All non-mortgage debt
  },

  FIRE: {
    BUDGET_ESSENTIALS: 1,
    STARTER_EMERGENCY_FUND: 2,    // 1 month expenses
    EMPLOYER_MATCH: 3,            // Free money first
    HIGH_INTEREST_DEBT: 4,        // >7% (toxic)
    MODERATE_INTEREST_DEBT: 7,    // 4-7% (optional)
    FULL_EMERGENCY_FUND: 6,       // 3-6 months
    HSA: 5,                       // Tax-advantaged
    ROTH_IRA: 5,                  // Tax-advantaged
    RETIREMENT_CONTRIBUTION: 8,   // Max 401k
    MAX_RETIREMENT: 8,            // Max all accounts
    CHILDREN_COLLEGE: 10,         // Low priority
    TAXABLE_INVESTING: 9,         // Bridge accounts
    PAY_OFF_MORTGAGE: 10,         // Only if rate >7%
    LOW_INTEREST_DEBT: 11,        // Never pay extra on <4%
  },

  FOO: {
    BUDGET_ESSENTIALS: 1,
    STARTER_EMERGENCY_FUND: 2,    // Deductible coverage
    EMPLOYER_MATCH: 3,            // Free money first
    HIGH_INTEREST_DEBT: 4,        // >6-7%
    MODERATE_INTEREST_DEBT: 10,   // After 25% savings
    FULL_EMERGENCY_FUND: 5,       // 3-6 months
    HSA: 6,                       // Tax-free growth
    ROTH_IRA: 6,                  // Tax-free growth
    RETIREMENT_CONTRIBUTION: 7,   // Until 25% savings rate
    MAX_RETIREMENT: 7,            // Part of 25%
    CHILDREN_COLLEGE: 9,          // Pre-paid expenses
    TAXABLE_INVESTING: 8,         // Hyper-accumulation
    PAY_OFF_MORTGAGE: 10,         // After 25% secured
    LOW_INTEREST_DEBT: 10,        // After 25% secured
  },
};

// Step metadata for display
export const STEP_METADATA: Record<FinancialAction, {
  title: string;
  descriptions: Record<StrategyType, string>;
  isDebtStep: boolean;
}> = {
  BUDGET_ESSENTIALS: {
    title: 'Cover Your Essentials',
    descriptions: {
      RAMSEY: 'Cover food, utilities, shelter, and transportation first.',
      FIRE: 'Cover basic survival costs before any investing.',
      FOO: 'Cover the "Four Walls" - food, utilities, shelter, transportation.',
    },
    isDebtStep: false,
  },

  STARTER_EMERGENCY_FUND: {
    title: 'Starter Emergency Fund',
    descriptions: {
      RAMSEY: 'Save exactly $1,000-$2,000 as a starter emergency fund.',
      FIRE: 'Save 1 month of living expenses as a buffer.',
      FOO: 'Save enough to cover your highest insurance deductible.',
    },
    isDebtStep: false,
  },

  EMPLOYER_MATCH: {
    title: 'Get Your Employer Match',
    descriptions: {
      RAMSEY: 'Contribute enough to get your full employer 401k match (part of 15%).',
      FIRE: 'Contribute enough to get 100% of the employer match - it\'s free money.',
      FOO: 'Contribute enough to get the full employer match before anything else.',
    },
    isDebtStep: false,
  },

  HIGH_INTEREST_DEBT: {
    title: 'Eliminate High-Interest Debt',
    descriptions: {
      RAMSEY: 'Attack all non-mortgage debt starting with the smallest balance.',
      FIRE: 'Destroy any debt with interest rate above 7% (toxic debt).',
      FOO: 'Pay off high-interest consumer debt (credit cards, loans >6-7%).',
    },
    isDebtStep: true,
  },

  MODERATE_INTEREST_DEBT: {
    title: 'Moderate Interest Debt',
    descriptions: {
      RAMSEY: 'All non-mortgage debt gets paid off in the debt snowball.',
      FIRE: 'Optional: Pay off 4-7% debt only if it helps you sleep at night.',
      FOO: 'Address after achieving 25% savings rate.',
    },
    isDebtStep: true,
  },

  FULL_EMERGENCY_FUND: {
    title: 'Full Emergency Fund',
    descriptions: {
      RAMSEY: 'Build 3-6 months of expenses in savings.',
      FIRE: 'Build 3-6 months of liquid cash (adjust for job stability).',
      FOO: 'Build a full 3-6 month emergency reserve.',
    },
    isDebtStep: false,
  },

  HSA: {
    title: 'Max Your HSA',
    descriptions: {
      RAMSEY: 'HSA contributions count toward your 15% retirement goal.',
      FIRE: 'Max out your HSA - triple tax advantage.',
      FOO: 'Max out HSA for tax-free growth on medical expenses.',
    },
    isDebtStep: false,
  },

  ROTH_IRA: {
    title: 'Max Your Roth IRA',
    descriptions: {
      RAMSEY: 'Roth IRA contributions count toward your 15% retirement goal.',
      FIRE: 'Max out your Roth IRA for tax-free growth.',
      FOO: 'Max out Roth IRA - tax-free growth bucket.',
    },
    isDebtStep: false,
  },

  RETIREMENT_CONTRIBUTION: {
    title: 'Hit Your Retirement Target',
    descriptions: {
      RAMSEY: 'Invest 15% of your gross income for retirement.',
      FIRE: 'Maximize all tax-advantaged retirement space.',
      FOO: 'Increase contributions until you hit a 25% savings rate.',
    },
    isDebtStep: false,
  },

  MAX_RETIREMENT: {
    title: 'Max All Retirement Accounts',
    descriptions: {
      RAMSEY: 'After the house is paid off, max out all retirement options.',
      FIRE: 'Max out remaining 401k/403b contribution space.',
      FOO: 'Continue increasing 401k until total savings hits 25%.',
    },
    isDebtStep: false,
  },

  CHILDREN_COLLEGE: {
    title: 'Save for Children\'s Education',
    descriptions: {
      RAMSEY: 'Fund ESA or 529 plans for your children\'s college.',
      FIRE: 'Low priority - only after retirement is secured.',
      FOO: 'Pre-pay future expenses like college after securing 25% savings.',
    },
    isDebtStep: false,
  },

  TAXABLE_INVESTING: {
    title: 'Taxable Brokerage Investing',
    descriptions: {
      RAMSEY: 'Build wealth phase - invest after the house is paid off.',
      FIRE: 'Hyper-accumulate in taxable accounts for early retirement bridge.',
      FOO: 'Invest surplus in taxable accounts to bridge to retirement.',
    },
    isDebtStep: false,
  },

  PAY_OFF_MORTGAGE: {
    title: 'Pay Off Your Mortgage',
    descriptions: {
      RAMSEY: 'Direct all surplus cash to paying off the house early.',
      FIRE: 'Only pay extra if your rate is higher than expected returns (>7%).',
      FOO: 'Pay off mortgage only after steps 1-9 are secured and saving 25%.',
    },
    isDebtStep: true,
  },

  LOW_INTEREST_DEBT: {
    title: 'Low-Interest Debt',
    descriptions: {
      RAMSEY: 'All non-mortgage debt is eliminated in the debt snowball.',
      FIRE: 'Never pay extra on debt below 4% - invest the difference.',
      FOO: 'Address low-interest debt only after 25% savings is secured.',
    },
    isDebtStep: true,
  },
};
