"use client";

export default function Tooltip({ text, children, position = "top", align = "center", color }) {
  const posClass = {
    top: "bottom-full mb-1.5",
    bottom: "top-full mt-1.5",
    left: "right-full top-1/2 -translate-y-1/2 mr-1.5",
    right: "left-full top-1/2 -translate-y-1/2 ml-1.5",
  }[position];

  // Alignment is only meaningful for top/bottom tooltips (a left/right tooltip is
  // already anchored to the trigger's side). "right" keeps the bubble inside
  // horizontally scrollable containers such as wide tables, where a centered
  // bubble would be clipped by the overflow box.
  const isVertical = position === "top" || position === "bottom";
  const alignClass = !isVertical
    ? ""
    : align === "right"
      ? "right-0"
      : align === "left"
        ? "left-0"
        : "left-1/2 -translate-x-1/2";

  const bgStyle = color ? { backgroundColor: color } : {};
  const bgClass = color ? "" : "bg-gray-900";

  return (
    <div className="relative inline-flex group/tt">
      {children}
      <div
        className={`pointer-events-none absolute ${posClass} ${alignClass} z-50 w-max max-w-56 rounded px-2 py-1 text-[11px] leading-snug ${bgClass} text-white opacity-0 group-hover/tt:opacity-100 transition-opacity duration-150 whitespace-normal`}
        style={bgStyle}
      >
        {text}
      </div>
    </div>
  );
}
