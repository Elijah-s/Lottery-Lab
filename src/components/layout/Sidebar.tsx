import { getVersion } from "@tauri-apps/api/app";
import { NavLink } from "react-router-dom";
import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  History,
  FlaskConical,
  Trophy,
  MessageSquareText,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
};

const NAV_ITEMS: readonly NavItem[] = [
  { to: "/", label: "推荐", icon: LayoutDashboard },
  { to: "/history", label: "历史", icon: History },
  { to: "/backtests", label: "回测", icon: FlaskConical },
  { to: "/worldcup", label: "世界杯", icon: Trophy },
  { to: "/prompts", label: "提示词", icon: MessageSquareText },
  { to: "/settings", label: "设置", icon: Settings },
];

export function Sidebar(): JSX.Element {
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    let active = true;
    getVersion()
      .then((value) => {
        if (active) setVersion(value);
      })
      .catch(() => {
        if (active) setVersion("");
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <aside className="flex w-full shrink-0 flex-col border-b border-border bg-card/40 md:h-full md:w-56 md:border-b-0 md:border-r">
      <div className="px-4 py-4 md:px-5 md:py-6">
        <h1 className="text-lg font-semibold tracking-tight">Lottery Lab</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          双色球 · 大乐透 · 本地实验台
        </p>
      </div>
      <nav className="flex gap-1 overflow-x-auto px-2 pb-3 md:flex-1 md:flex-col md:overflow-visible md:pb-4">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              cn(
                "flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors md:gap-3",
                "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                isActive && "bg-accent text-accent-foreground font-medium",
              )
            }
          >
            <item.icon className="h-4 w-4" aria-hidden />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="hidden px-5 py-4 text-[11px] text-muted-foreground md:block">
        {version ? `版本 ${version} · 本地版` : "本地版"}
      </div>
    </aside>
  );
}
