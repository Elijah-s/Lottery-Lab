import { Navigate, Route, Routes } from "react-router-dom";
import { Sidebar } from "@/components/layout/Sidebar";
import { DashboardPage } from "@/pages/DashboardPage";
import { HistoryPage } from "@/pages/HistoryPage";
import { BacktestsPage } from "@/pages/BacktestsPage";
import { PromptsPage } from "@/pages/PromptsPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { WorldCupPage } from "@/pages/WorldCupPage";

export default function App(): JSX.Element {
  return (
    <div className="flex h-full min-h-screen w-full bg-background text-foreground">
      <Sidebar />
      <main className="flex-1 overflow-auto">
        <div className="mx-auto max-w-5xl px-8 py-10">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/backtests" element={<BacktestsPage />} />
            <Route path="/worldcup" element={<WorldCupPage />} />
            <Route path="/prompts" element={<PromptsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}
