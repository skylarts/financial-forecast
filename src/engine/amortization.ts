export function computeMonthlyPayment(
  principal: number,
  annualInterestRatePct: number,
  termMonths: number
): number {
  const monthlyRate = annualInterestRatePct / 12;
  if (monthlyRate === 0) return principal / termMonths;
  return (principal * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -termMonths));
}

export interface AmortizationStep {
  interestPortion: number;
  principalPortion: number;
  newBalance: number;
}

/** One month of standard fixed-rate amortization. Caps the payment at the remaining balance + interest. */
export function amortizeMonth(
  balance: number,
  annualInterestRatePct: number,
  monthlyPayment: number
): AmortizationStep {
  const monthlyRate = annualInterestRatePct / 12;
  const interestPortion = balance * monthlyRate;
  const principalPortion = Math.min(monthlyPayment - interestPortion, balance);
  const newBalance = Math.max(0, balance - principalPortion);
  return { interestPortion, principalPortion, newBalance };
}
