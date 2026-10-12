import { describe, expect, it, vi } from "vitest";
import { createClarinDynCaller, createClarinInvoker, createClarinNamedFunction } from "../subset/woff2/clarinCspBindings";

const fail = (message: string): never => { throw new Error(message); };
const converter = (name = "int") => ({ name, toWireType: (_stack: unknown, value: unknown) => value, fromWireType: (value: unknown) => value, destructorFunction: null as null | ((value: unknown) => void) | undefined });

describe("CSP-safe WOFF2 bindings", () => {
  it("preserves callable names, arity, receivers and constructor semantics without Function compilation", () => {
    const named = createClarinNamedFunction("Example", function (this: { value: number }, value: number) { this.value = value; }, 1);
    const instance = new (named as any)(7);
    expect(instance.value).toBe(7);
    expect(instance).toBeInstanceOf(named);
    expect(named.name).toBe("Example");
    expect(named.length).toBe(1);
    const receiver = { value: 0 };
    named.call(receiver, 4);
    expect(receiver.value).toBe(4);
  });
  it("preserves dynamic caller argument count, missing values and return", () => {
    const target = vi.fn((...args: unknown[]) => args);
    const caller = createClarinDynCaller("iii", 23, target);
    expect(caller(7, 8, 9)).toEqual([23, 7, 8]);
    expect(caller(7)).toEqual([23, 7, undefined]);
    expect(caller.length).toBe(2);
    expect(caller.name).toBe("dynCall_iii_23");
  });
  it("preserves class conversion, invocation, direct destruction and return conversion order", () => {
    const calls: string[] = [];
    const receiver = { pointer: 11 };
    const classType = { ...converter(), toWireType: (_stack: unknown, value: typeof receiver) => { calls.push("this"); return value.pointer; }, destructorFunction: (value: number) => { calls.push(`destroy-this:${value}`); } };
    const argument = { ...converter(), toWireType: (_stack: unknown, value: number) => { calls.push("argument"); return value * 2; }, destructorFunction: (value: number) => { calls.push(`destroy-argument:${value}`); } };
    const resultType = { ...converter(), fromWireType: (value: number) => { calls.push("return"); return value + 1; } };
    const invoker = createClarinInvoker("method", "Example.method", [resultType, classType, argument], {}, (target, self, value) => { calls.push(`invoke:${target}:${self}:${value}`); return 42; }, 9, fail, vi.fn());
    expect(invoker.call(receiver, 3)).toBe(43);
    expect(calls).toEqual(["this", "argument", "invoke:9:11:6", "destroy-this:11", "destroy-argument:6", "return"]);
    expect(invoker.length).toBe(1);
  });
  it("uses the shared destructor stack for dynamic conversions and preserves void returns", () => {
    let receivedStack: unknown;
    const argument = { ...converter(), destructorFunction: undefined, toWireType: (stack: unknown[], value: unknown) => { stack.push("owned"); receivedStack = stack; return value; } };
    const destroy = vi.fn();
    const invoker = createClarinInvoker("function", "function", [converter("void"), null, argument], null, vi.fn(() => 99), 9, fail, destroy);
    expect(invoker(3)).toBeUndefined();
    expect(destroy).toHaveBeenCalledWith(receivedStack);
    expect(receivedStack).toEqual(["owned"]);
  });
  it("rejects wrong arity before conversions or native invocation", () => {
    const native = vi.fn();
    const invoker = createClarinInvoker("f", "f", [converter(), null, converter()], null, native, 9, fail, vi.fn());
    expect(() => invoker()).toThrow("function f called with 0 arguments, expected 1 args!");
    expect(native).not.toHaveBeenCalled();
  });
});
