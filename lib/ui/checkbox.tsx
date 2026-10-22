import React from "react";
import * as RadixCheckbox from "@radix-ui/react-checkbox";
import * as RadixSwitch from "@radix-ui/react-switch";
import { Check, Minus } from "lucide-react";

type Props = React.ComponentPropsWithoutRef<typeof RadixCheckbox.Root> & {
  appearance?: "checkbox" | "switch";
  indeterminate?: boolean;
};

/** Radix owns keyboard, label and native form behavior for both control types. */
export function Checkbox({
  appearance = "checkbox",
  indeterminate = false,
  checked,
  defaultChecked,
  className = "",
  ...props
}: Props) {
  if (appearance === "switch")
    return (
      <RadixSwitch.Root
        {...props}
        className={"switch-control " + className}
        checked={typeof checked === "boolean" ? checked : undefined}
        defaultChecked={defaultChecked === true}
      >
        <RadixSwitch.Thumb className="switch-thumb" />
      </RadixSwitch.Root>
    );
  return (
    <RadixCheckbox.Root
      {...props}
      className={"checkbox-control " + className}
      checked={indeterminate ? "indeterminate" : checked}
      defaultChecked={defaultChecked}
    >
      <RadixCheckbox.Indicator className="checkbox-indicator">
        {indeterminate || checked === "indeterminate" ? (
          <Minus size={12} strokeWidth={2.5} aria-hidden="true" />
        ) : (
          <Check size={12} strokeWidth={2.5} aria-hidden="true" />
        )}
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );
}
