import { createRoot } from "react-dom/client";
import { PortfolioScreen } from "@/components/portfolio/portfolio-screen";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Tauri application root element was not found.");
}

createRoot(rootElement).render(<PortfolioScreen />);