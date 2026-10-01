export type Computer = "windows" | "mac" | "linux";
export declare const computer: Computer;
export declare const COMPUTERS: Record<Computer, { name: string; open: string }>;
export declare function computerPick(el: HTMLElement, onChange: (os: Computer) => void): void;
