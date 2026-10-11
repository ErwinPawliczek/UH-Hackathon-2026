// A dropdown that is one control: the button carries its own name (and, once
// something is picked, what was picked) and opens a list beneath it. Built as
// a custom menu rather than a native <select> so the button can take the
// app's shape and the list its styling.
//
// Keyboard: Enter, Space or ArrowDown opens; ArrowUp/ArrowDown, Home and End
// move through the enabled entries; Enter or Space picks; Escape or Tab
// closes (Escape returns focus to the button). A click outside closes.

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

export interface MenuItem {
  key: string;
  label: string;
  /** shown ticked — already chosen */
  checked?: boolean;
  disabled?: boolean;
}

export function DropdownMenu({
  label,
  items,
  onPick,
  disabled = false,
  emptyText = 'Nothing to pick',
  testId,
}: {
  /** text on the button */
  label: string;
  items: MenuItem[];
  onPick: (key: string) => void;
  disabled?: boolean;
  /** shown in the list when there are no items */
  emptyText?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const itemEls = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();

  const enabled = items.map((it, i) => (it.disabled === true ? -1 : i)).filter((i) => i >= 0);

  // click outside closes
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current !== null && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // keyboard focus follows the active entry
  useEffect(() => {
    if (open && active >= 0) itemEls.current[active]?.focus();
  }, [open, active]);

  const openMenu = (toLast = false) => {
    setActive(enabled.length === 0 ? -1 : toLast ? enabled[enabled.length - 1] : enabled[0]);
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  const pick = (item: MenuItem) => {
    if (item.disabled === true) return;
    close(true);
    onPick(item.key);
  };
  const step = (dir: 1 | -1) => {
    if (enabled.length === 0) return;
    const at = enabled.indexOf(active);
    setActive(enabled[(at + dir + enabled.length) % enabled.length]);
  };

  const onButtonKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openMenu(e.key === 'ArrowUp');
    }
  };
  const onMenuKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'Home') { e.preventDefault(); if (enabled.length > 0) setActive(enabled[0]); }
    else if (e.key === 'End') { e.preventDefault(); if (enabled.length > 0) setActive(enabled[enabled.length - 1]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    else if (e.key === 'Tab') close(false);
  };

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        className={`btn ${open ? 'btn-active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={onButtonKey}
        data-testid={testId}
      >
        <span className="inline-block max-w-72 truncate align-bottom">{label}</span>
        <span aria-hidden="true" className="ml-2 text-[9px]">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <ul
          id={menuId}
          role="menu"
          className="panel absolute left-0 top-full z-30 mt-2 min-w-full list-none whitespace-nowrap bg-white p-1"
          onKeyDown={onMenuKey}
          data-testid={testId === undefined ? undefined : `${testId}-menu`}
        >
          {items.map((item, i) => (
            <li key={item.key} role="none">
              <button
                ref={(el) => { itemEls.current[i] = el; }}
                type="button"
                role="menuitemcheckbox"
                aria-checked={item.checked === true}
                disabled={item.disabled === true}
                tabIndex={i === active ? 0 : -1}
                className="menu-item"
                onClick={() => pick(item)}
                onPointerEnter={() => item.disabled !== true && setActive(i)}
                data-testid={testId === undefined ? undefined : `${testId}-${item.key}`}
              >
                <span aria-hidden="true" className="inline-block w-4 text-blue">{item.checked === true ? '✓' : ''}</span>
                {item.label}
              </button>
            </li>
          ))}
          {items.length === 0 && <li className="px-3 py-2 text-xs text-muted">{emptyText}</li>}
        </ul>
      )}
    </div>
  );
}
