import { t as tr } from "./i18n.js";
import React from "react";
import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
type Option = {
  value: string;
  label: string;
  disabled: boolean;
  group?: string;
};
function labelText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(labelText).join("");
  return React.isValidElement<{ children?: React.ReactNode }>(node)
    ? labelText(node.props.children)
    : "";
}
function readOptions(
  children: React.ReactNode,
  group?: string,
  disabled = false,
): Option[] {
  return React.Children.toArray(children).flatMap((child) => {
    if (!React.isValidElement<any>(child)) return [];
    const p = (child as React.ReactElement<any>).props;
    if (child.type === "optgroup")
      return readOptions(p.children, p.label, p.disabled);
    if (child.type === React.Fragment)
      return readOptions(p.children, group, disabled);
    if (child.type !== "option") return [];
    const label = labelText(p.children);
    return [
      {
        value: String(p.value ?? label),
        label,
        disabled: disabled || !!p.disabled,
        group,
      },
    ];
  });
}
/** Adapt the existing native option/form contract to Radix Select. */
export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const {
    children,
    value,
    defaultValue,
    onChange,
    className = "",
    style,
    id: suppliedId,
    ...nativeProps
  } = props;
  const generatedId = React.useId();
  const id = suppliedId ?? generatedId;
  const options = readOptions(children);
  const native = React.useRef<HTMLSelectElement>(null);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const resetting = React.useRef(false);
  const [internal, setInternal] = React.useState(
    String(defaultValue ?? options[0]?.value ?? ""),
  );
  const [open, setOpen] = React.useState(false);
  const selectedValue = value === undefined ? internal : String(value);
  const selected = options.find((option) => option.value === selectedValue);
  const optionsKey = options
    .map((option) => option.value + ":" + option.disabled)
    .join("\u0000");
  React.useEffect(() => {
    if (value === undefined && native.current)
      setInternal(native.current.value);
  }, [optionsKey, value]);
  React.useEffect(() => {
    const form = native.current?.form;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reset = () => {
      resetting.current = true;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (native.current) {
          if (value === undefined) setInternal(native.current.value);
          else native.current.value = String(value);
        }
        resetting.current = false;
      }, 0);
    };
    // Radix has its own form reset listener. Keep the public native value and
    // suppress change callbacks while both controls restore their defaults.
    form?.addEventListener("reset", reset, true);
    return () => {
      form?.removeEventListener("reset", reset, true);
      clearTimeout(timer);
      resetting.current = false;
    };
  }, [value]);
  React.useEffect(() => {
    if (props.disabled) setOpen(false);
  }, [props.disabled]);
  if (props.multiple || (props.size ?? 0) > 1) return <select {...props} />;
  return (
    <span className="select-root" style={style}>
      <RadixSelect.Root
        value={"v:" + selectedValue}
        open={open}
        onOpenChange={setOpen}
        disabled={props.disabled}
        onValueChange={(encoded) => {
          if (resetting.current) return;
          if (native.current) {
            native.current.value = encoded.slice(2);
            native.current.dispatchEvent(
              new Event("change", { bubbles: true }),
            );
          }
        }}
      >
        <RadixSelect.Trigger
          ref={trigger}
          id={id}
          className={"select-trigger " + className}
          aria-label={props["aria-label"]}
          aria-labelledby={props["aria-labelledby"]}
          aria-describedby={props["aria-describedby"]}
          aria-required={props.required}
          title={props.title}
          autoFocus={props.autoFocus}
        >
          <RadixSelect.Value>
            {selected?.label ?? tr("请选择")}
          </RadixSelect.Value>
          <RadixSelect.Icon asChild>
            <ChevronDown size={14} aria-hidden="true" />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>
        <RadixSelect.Portal
          container={
            trigger.current?.closest<HTMLElement>(".dialog-layer, dialog") ??
            undefined
          }
        >
          <RadixSelect.Content
            position="popper"
            sideOffset={5}
            align="start"
            collisionPadding={8}
            className="select-options"
            aria-label={props["aria-label"] ?? tr("可选项")}
          >
            <RadixSelect.Viewport>
              {options.map((option, index) => (
                <React.Fragment key={option.value + ":" + index}>
                  {option.group &&
                    options[index - 1]?.group !== option.group && (
                      <div className="select-group" role="presentation">
                        {option.group}
                      </div>
                    )}
                  <RadixSelect.Item
                    value={"v:" + option.value}
                    disabled={option.disabled}
                    textValue={option.label}
                  >
                    <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                    <RadixSelect.ItemIndicator>
                      <Check size={14} aria-hidden="true" />
                    </RadixSelect.ItemIndicator>
                  </RadixSelect.Item>
                </React.Fragment>
              ))}
              {!options.length && (
                <div className="select-group">{tr("暂无选项")}</div>
              )}
            </RadixSelect.Viewport>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>
      <select
        {...nativeProps}
        ref={native}
        id={id + "-native"}
        className="select-native"
        value={value}
        defaultValue={defaultValue}
        aria-hidden="true"
        aria-label={undefined}
        aria-labelledby={undefined}
        aria-describedby={undefined}
        tabIndex={-1}
        onInvalid={(event) => {
          event.preventDefault();
          trigger.current?.focus();
          setOpen(true);
          props.onInvalid?.(event);
        }}
        onChange={(event) => {
          setInternal(event.target.value);
          onChange?.(event);
        }}
      >
        {children}
      </select>
    </span>
  );
}
