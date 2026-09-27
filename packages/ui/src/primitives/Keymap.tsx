import { Kbd } from "@heroui/react";

/** A small keymap: keys on the left, what they do on the right. */
export function Keymap({ items }: { items: [keys: string[], action: string][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] items-center gap-x-4 gap-y-2 text-sm">
      {items.map(([keys, action]) => (
        <div key={action} className="contents">
          <dt className="flex gap-1">
            {keys.map((k) => (
              <Kbd key={k}>{k}</Kbd>
            ))}
          </dt>
          <dd className="text-muted">{action}</dd>
        </div>
      ))}
    </dl>
  );
}
