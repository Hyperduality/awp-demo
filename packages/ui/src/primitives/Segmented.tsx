import { ToggleButton, ToggleButtonGroup } from "@heroui/react";
import type { ReactNode } from "react";

/** A single-choice segmented control on HeroUI's toggle button group. */
export function Segmented<K extends string>(props: {
  label: string;
  value: K;
  onChange(value: NoInfer<K>): void;
  options: { id: NoInfer<K>; label: ReactNode }[];
}) {
  return (
    <ToggleButtonGroup
      aria-label={props.label}
      size="sm"
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={new Set([props.value])}
      onSelectionChange={(keys) => {
        const k = [...keys][0];
        if (k !== undefined && k !== props.value) props.onChange(String(k) as K);
      }}
    >
      {props.options.map((o, i) => (
        <ToggleButton key={o.id} id={o.id}>
          {i > 0 && <ToggleButtonGroup.Separator />}
          {o.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
