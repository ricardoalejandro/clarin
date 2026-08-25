import type { JSX } from "react";
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
    onPointerDown?: (event: React.PointerEvent<HTMLButtonElement>) => void;
    onClick: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void;
}
export declare const ButtonIcon: import("react").ForwardRefExoticComponent<ButtonIconProps & import("react").RefAttributes<HTMLButtonElement>>;
export {};
