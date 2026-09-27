import { Button, Tooltip } from "@heroui/react";
import type { ComponentProps, ReactNode } from "react";

type ButtonProps = ComponentProps<typeof Button>;

/** An icon-only button that always carries a tooltip. */
export function IconButton({
  label,
  children,
  variant = "ghost",
  size = "sm",
  ...props
}: Omit<ButtonProps, "children" | "isIconOnly"> & { label: string; children: ReactNode }) {
  return (
    <Tooltip delay={600} closeDelay={0}>
      <Button aria-label={label} isIconOnly variant={variant} size={size} {...props}>
        {children}
      </Button>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip>
  );
}
