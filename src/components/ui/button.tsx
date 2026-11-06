import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full border font-medium transition-[background-color,border-color,color,opacity] duration-150 ease-out disabled:pointer-events-none disabled:opacity-50 disabled:shadow-[inset_0_0_0_1px_var(--color-line-strong)] min-h-11 px-4 text-sm",
  {
    variants: {
      variant: {
        primary: "border-transparent bg-pine text-pine-ink hover:opacity-90",
        quiet: "border-line-strong bg-paper-raised text-ink hover:bg-paper-deep",
        ghost: "border-transparent bg-transparent text-ink hover:bg-paper-deep",
      },
    },
    defaultVariants: { variant: "primary" },
  },
);

export function Button({
  className,
  variant,
  asChild = false,
  type = "button",
  ...props
}: ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant }), className)} type={type} {...props} />;
}
