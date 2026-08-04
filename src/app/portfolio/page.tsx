import type { Metadata } from "next";
import { PortfolioApp } from "@/components/portfolio/PortfolioApp";

export const metadata: Metadata = {
  title: "Portfolio",
  description: "Holdings, tax lots, and performance for the accounts behind the forecast.",
};

export default function PortfolioPage() {
  return <PortfolioApp />;
}
