import { getVersion } from "@tauri-apps/api/app";
import { NavLink } from "react-router-dom";
import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  History,
  FlaskConical,
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
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-border bg-card/40">
      <div className="px-5 py-6">
        <h1 className="text-lg font-semibold tracking-tight">Lottery Lab</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          双色球 · 大乐透 · 本地实验台
        </p>
      </div>
      <nav className="flex flex-1 flex-col gap-1 px-2 pb-4">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
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
      <div className="px-5 py-4 text-[11px] text-muted-foreground">
        {version ? `版本 ${version} · 本地版` : "本地版"}
      </div>
    </aside>
  );
}
