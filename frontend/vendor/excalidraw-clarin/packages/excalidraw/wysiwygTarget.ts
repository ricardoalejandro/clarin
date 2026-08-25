export const isWysiwygTarget = (
  target: EventTarget | null,
): boolean => {
  const element =
    target instanceof Element
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;
  return Boolean(element?.closest('[data-type="wysiwyg"]'));
};
