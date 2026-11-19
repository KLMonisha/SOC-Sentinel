import type { ElementType, HTMLAttributes, ReactNode } from "react";
import { Brackets } from "./Brackets";

type Level = "plane" | "raised" | "lit";
const MAT: Record<Level, string> = { plane: "mat-plane", raised: "mat-raised", lit: "mat-lit" };

interface Props extends HTMLAttributes<HTMLElement> {
  level?: Level;
  brackets?: boolean | "hover";
  as?: ElementType;
  children?: ReactNode;
}

/** A material, not a bordered box: separation comes from tone and a top highlight. */
export function Surface({ level = "plane", brackets = false, as: Tag = "div", className = "", children, ...rest }: Props) {
  const b = brackets === "hover" ? "brk brk-hover" : brackets ? "brk" : "";
  return (
    <Tag className={`${MAT[level]} ${b} ${className}`} {...rest}>
      {brackets && <Brackets />}
      {children}
    </Tag>
  );
}
