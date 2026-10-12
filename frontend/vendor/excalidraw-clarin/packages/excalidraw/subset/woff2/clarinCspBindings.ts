type Callable = (this: any, ...args: any[]) => any;
type Converter = {
  name: string;
  toWireType: Callable;
  fromWireType: Callable;
  destructorFunction?: Callable | null;
};

/** Equivalent embind closures without compiling JavaScript strings at runtime. */
export function createClarinNamedFunction(name: string, body: Callable, arity = 0) {
  const fn = function (this: any, ...args: any[]) {
    return body.apply(this, args);
  };
  Object.defineProperty(fn, "name", { value: name, configurable: true });
  Object.defineProperty(fn, "length", { value: arity, configurable: true });
  return fn;
}

export function createClarinDynCaller(signature: string, rawFunction: number, dynCall: Callable) {
  const arity = signature.length - 1;
  return createClarinNamedFunction(`dynCall_${signature}_${rawFunction}`, function (...args: any[]) {
    return dynCall(rawFunction, ...Array.from({ length: arity }, (_, index) => args[index]));
  }, arity);
}

export function createClarinInvoker(
  name: string,
  humanName: string,
  argTypes: Array<Converter | null>,
  classType: unknown,
  cppInvoker: Callable,
  cppTarget: unknown,
  throwBindingError: (message: string) => never,
  runDestructors: (stack: any[]) => void,
) {
  if (argTypes.length < 2) {
    throwBindingError("argTypes array size mismatch! Must at least get return value and 'this' types!");
  }
  const classMethod = argTypes[1] !== null && classType !== null;
  const needsStack = argTypes.slice(1).some(type => type !== null && type.destructorFunction === undefined);
  const returnType = argTypes[0]!;
  return createClarinNamedFunction(name, function (...args: any[]) {
    if (args.length !== argTypes.length - 2) {
      throwBindingError(`function ${humanName} called with ${args.length} arguments, expected ${argTypes.length - 2} args!`);
    }
    const destructors = needsStack ? [] : null;
    const wired: any[] = [];
    if (classMethod) wired.push(argTypes[1]!.toWireType(destructors, this));
    for (let index = 0; index < args.length; index++) {
      wired.push(argTypes[index + 2]!.toWireType(destructors, args[index]));
    }
    const result = cppInvoker(cppTarget, ...wired);
    // Keep embind's conversion, invocation and destruction order unchanged.
    if (destructors) runDestructors(destructors);
    else {
      for (let index = classMethod ? 1 : 2; index < argTypes.length; index++) {
        const destructor = argTypes[index]!.destructorFunction;
        if (destructor !== null) destructor!(wired[index - (classMethod ? 1 : 2)]);
      }
    }
    return returnType.name !== "void" ? returnType.fromWireType(result) : undefined;
  }, argTypes.length - 2);
}
