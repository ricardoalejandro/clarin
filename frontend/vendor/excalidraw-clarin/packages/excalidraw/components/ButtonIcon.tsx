import { forwardRef } from "react";
import type { JSX } from "react";
import clsx from "clsx";

import "./ButtonIcon.scss";

interface ButtonIconProps {
  icon: JSX.Element;
  title: string;
  className?: string;
  testId?: string;
  /** if not supplied, defaults to value identity check */
  active?: boolean;
  /** include standalone style (could interfere with parent styles) */
  standalone?: boolean;
  disabled?: boolean;
  ariaPressed?: boolean | "mixed";
  onPointerDown?: (
    event: React.PointerEvent<HTMLButtonElement>,
  ) => void;
  onClick: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void;
}

export const ButtonIcon = forwardRef<HTMLButtonElement, ButtonIconProps>(
  (props, ref) => {
    const {
      title,
      className,
      testId,
      active,
      standalone,
      disabled,
      ariaPressed,
      icon,
      onPointerDown,
      onClick,
    } = props;
    return (
      <button
        type="button"
        ref={ref}
        key={title}
        title={title}
        data-testid={testId}
        disabled={disabled}
        aria-pressed={ariaPressed}
        className={clsx(className, { standalone, active })}
        onPointerDown={onPointerDown}
        onClick={onClick}
      >
        {icon}
      </button>
    );
  },
);
