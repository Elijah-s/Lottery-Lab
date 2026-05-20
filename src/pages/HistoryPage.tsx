/**
 * Recommendation history + auto-review results.
 *
 * Review state per recommendation is joined client-side so the table
 * shows "待复盘 / 已复盘 (命中 X 红 Y 蓝)" without Rust-side joins.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCheck, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import {
  deleteRecommendations,
  listRecommendations,
  listReviews,
  reviewPending,
  type RecommendationDto,
  type ReviewDto,
} from "@/lib/ipc";
import { cn } from "@/lib/utils";

export function HistoryPage(): JSX.Element {
  const queryClient = useQueryClient();
  const [selectedIds, setSelectedIds] = useState<number[]>([]);

  const recsQuery = useQuery({
    queryKey: ["recommendations"],
    queryFn: () => listRecommendations(50),
  });
  const reviewsQuery = useQuery({
    queryKey: ["reviews"],
    queryFn: () => listReviews(200),
  });

  const reviewMutation = useMutation({
    mutationFn: () => reviewPending(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reviews"] });
      queryClient.invalidateQueries({ queryKey: ["recommendations"] });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (ids: number[]) => deleteRecommendations(ids),
    onSuccess: () => {
      setSelectedIds([]);
      queryClient.invalidateQueries({ queryKey: ["reviews"] });
      queryClient.invalidateQueries({ queryKey: ["recommendations"] });
    },
  });

  const reviewMap = useMemo(() => {
    const map = new Map<number, ReviewDto>();
    (reviewsQuery.data ?? []).forEach((review) => {
      map.set(review.recommendation_id, review);
    });
    return map;
  }, [reviewsQuery.data]);

  const rows = recsQuery.data ?? [];
  const counts = {
    total: rows.length,
    reviewed: rows.filter((rec) => reviewMap.has(rec.id)).length,
  };
  const allVisibleSelected =
    rows.length > 0 && rows.every((rec) => selectedIds.includes(rec.id));
  const toggleSelected = (id: number) => {
    setSelectedIds((prev) =>
      prev.includes(id)
        ? prev.filter((item) => item !== id)
        : [...prev, id],
    );
  };

  return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">历史</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            查看过往推荐以及同步后的自动复盘结果。
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm",
              "hover:bg-accent hover:text-accent-foreground transition-colors",
              reviewMutation.isPending && "opacity-60 cursor-wait",
            )}
            onClick={() => reviewMutation.mutate()}
            disabled={reviewMutation.isPending}
          >
            <CheckCheck className="h-4 w-4" aria-hidden />
            {reviewMutation.isPending ? "复盘中…" : "立即复盘"}
          </button>
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-2 rounded-md border border-destructive/40 px-3 py-1.5 text-sm text-destructive",
              "hover:bg-destructive/10 transition-colors",
              (deleteMutation.isPending || selectedIds.length === 0) &&
                "opacity-60 cursor-not-allowed",
            )}
            onClick={() => deleteMutation.mutate(selectedIds)}
            disabled={deleteMutation.isPending || selectedIds.length === 0}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
            删除选中
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          共 {counts.total} 条推荐 · 已复盘 {counts.reviewed} · 已选 {selectedIds.length}
        </span>
        {rows.length > 0 && (
          <label className="inline-flex items-center gap-1">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={(event) =>
                setSelectedIds(event.target.checked ? rows.map((rec) => rec.id) : [])
              }
            />
            全选当前列表
          </label>
        )}
      </div>
      {deleteMutation.isError && (
        <p className="text-sm text-destructive">
          删除失败：{(deleteMutation.error as Error).message}
        </p>
      )}

      {recsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">读取历史…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
          暂无推荐。去「推荐」页生成第一个。
        </p>
      ) : (
        <ul className="space-y-3">
          {rows.map((rec) => (
            <HistoryRow
              key={rec.id}
              rec={rec}
              review={reviewMap.get(rec.id) ?? null}
              selected={selectedIds.includes(rec.id)}
              onToggle={() => toggleSelected(rec.id)}
              onDelete={() => deleteMutation.mutate([rec.id])}
              deletePending={deleteMutation.isPending}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function HistoryRow({
  rec,
  review,
  selected,
  onToggle,
  onDelete,
  deletePending,
}: {
  rec: RecommendationDto;
  review: ReviewDto | null;
  selected: boolean;
  onToggle: () => void;
  onDelete: () => void;
  deletePending: boolean;
}): JSX.Element {
  const lotteryLabel = rec.lottery_type === "ssq" ? "双色球" : "大乐透";
  return (
    <li className="rounded-md border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 shrink-0"
            checked={selected}
            onChange={onToggle}
            aria-label={`选择 ${rec.ticket_text}`}
          />
          <div className="min-w-0 space-y-1">
            <div className="text-sm font-medium">
              {rec.ticket_text}
            </div>
            <div className="text-xs text-muted-foreground">
              {lotteryLabel} · 目标期号 {rec.target_issue} · {rec.stake_amount} 元 · 评分 {rec.heuristic_score.toFixed(2)}
            </div>
            <div className="text-xs text-muted-foreground">
              {rec.user_request}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ReviewBadge review={review} lotteryType={rec.lottery_type} />
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-60"
            onClick={onDelete}
            disabled={deletePending}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            删除
          </button>
        </div>
      </div>
    </li>
  );
}

function ReviewBadge({
  review,
  lotteryType,
}: {
  review: ReviewDto | null;
  lotteryType: string;
}): JSX.Element {
  if (!review) {
    return (
      <span className="rounded-md border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground">
        待复盘
      </span>
    );
  }
  const primaryLabel = lotteryType === "ssq" ? "红" : "前";
  const secondaryLabel = lotteryType === "ssq" ? "蓝" : "后";
  const hit =
    review.primary_hits > 0 || review.secondary_hits > 0;
  return (
    <span
      className={cn(
        "rounded-md px-2 py-0.5 text-xs",
        hit
          ? "bg-emerald-100 text-emerald-900"
          : "bg-muted text-muted-foreground",
      )}
    >
      {primaryLabel} {review.primary_hits} · {secondaryLabel} {review.secondary_hits}
    </span>
  );
}
