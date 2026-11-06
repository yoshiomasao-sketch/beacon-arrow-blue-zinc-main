import { createFileRoute } from "@tanstack/react-router";
import { PortfolioScreen } from "@/components/portfolio/portfolio-screen";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <PortfolioScreen />;
}
