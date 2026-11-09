import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:outline-none [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default:
          "border-[var(--border-focus)] text-[var(--accent)]" +
          " [background:var(--accent-dim)]",
        secondary:
          "border-[var(--border)] text-[var(--text-secondary)]" +
          " [background:var(--border)]",
        destructive:
          "border-[var(--danger-border)] text-[var(--danger)]" +
          " [background:var(--danger-bg)]",
        outline:
          "border-[var(--border)] text-[var(--text-secondary)] bg-transparent",
        ghost:
          "border-transparent text-[var(--text-secondary)] bg-transparent hover:[background:var(--border)]",
        link:
          "border-transparent text-[var(--accent-hover)] underline-offset-4 hover:underline",
        /* ── New semantic variants ── */
        success:
          "border-[var(--success-border)] text-[var(--success)] [background:var(--success-bg)]",
        warning:
          "border-[var(--warning-border)] text-[var(--warning)] [background:var(--warning-bg)]",
        danger:
          "border-[var(--danger-border)] text-[var(--danger)] [background:var(--danger-bg)]",
        info:
          "border-[var(--info-border)] text-[var(--info)] [background:var(--info-bg)]",
        accent:
          "border-[var(--border-focus)] text-[var(--accent-hover)] [background:var(--accent-dim)]",
        muted:
          "border-[var(--border)] text-[var(--text-tertiary)] [background:var(--border)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
