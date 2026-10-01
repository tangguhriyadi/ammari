import { NavLink, type NavLinkItem } from "./nav-link";
import { Sheet } from "./sheet";

export function MoreSheet({
  open,
  onOpenChange,
  items,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: readonly NavLinkItem[];
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Lainnya">
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => (
          <li key={item.href}>
            <NavLink href={item.href} label={item.label} icon={item.icon} onClick={() => onOpenChange(false)} />
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
