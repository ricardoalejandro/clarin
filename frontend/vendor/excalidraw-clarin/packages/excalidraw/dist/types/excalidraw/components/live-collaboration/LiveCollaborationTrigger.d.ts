import "./LiveCollaborationTrigger.scss";
declare const LiveCollaborationTrigger: {
    ({ isCollaborating, onSelect, ...rest }: {
        isCollaborating: boolean;
        onSelect: () => void;
    } & React.ButtonHTMLAttributes<HTMLButtonElement>): import("react/jsx-runtime").JSX.Element;
    displayName: string;
};
export default LiveCollaborationTrigger;
