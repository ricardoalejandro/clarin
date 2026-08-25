import type { JSX } from "react";
import React from "react";
import type { ValueOf } from "../../utility-types";
declare const DropdownMenuItem: {
    ({ icon, value, order, children, shortcut, className, hovered, selected, textStyle, onSelect, onClick, ...rest }: {
        icon?: JSX.Element;
        value?: string | number | undefined;
        order?: number;
        onSelect?: (event: Event) => void;
        children: React.ReactNode;
        shortcut?: string;
        hovered?: boolean;
        selected?: boolean;
        textStyle?: React.CSSProperties;
        className?: string;
    } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onSelect">): import("react/jsx-runtime").JSX.Element;
    displayName: string;
    Badge: {
        ({ type, children, }: {
            type?: ValueOf<typeof DropDownMenuItemBadgeType>;
            children: React.ReactNode;
        }): import("react/jsx-runtime").JSX.Element;
        displayName: string;
    };
};
export declare const DropDownMenuItemBadgeType: {
    readonly GREEN: "green";
    readonly RED: "red";
    readonly BLUE: "blue";
};
export declare const DropDownMenuItemBadge: {
    ({ type, children, }: {
        type?: ValueOf<typeof DropDownMenuItemBadgeType>;
        children: React.ReactNode;
    }): import("react/jsx-runtime").JSX.Element;
    displayName: string;
};
export default DropdownMenuItem;
