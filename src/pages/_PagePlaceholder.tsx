import type { ReactNode } from "react";

type Props = {
  title: string;
  description: string;
  children?: ReactNode;
};

export function PagePlaceholder({ title, description, children }: Props): JSX.Element {
  return (
    <section className="space-y-4">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      </header>
      <div className="rounded-lg border border-dashed border-border p-8 text-sm text-muted-foreground">
        {children ?? "占位页。功能将在后续 PR 中填充。"}
      </div>
    </section>
  );
}
