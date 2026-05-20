import { SyncStatusCard } from "@/components/SyncStatusCard";
import { RecommendationPanel } from "@/components/RecommendationPanel";

export function DashboardPage(): JSX.Element {
  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight">推荐</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          一句自然语言描述，生成合规候选并由智能模型解释。
        </p>
      </header>
      <RecommendationPanel />
      <SyncStatusCard />
    </div>
  );
}
